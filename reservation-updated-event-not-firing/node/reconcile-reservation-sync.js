/**
 * Reconcile Medusa reservations whose update event never fired.
 *
 * Medusa v2's InventoryModuleService.updateReservationItem emitted the wrong
 * event constant (confirmed in medusajs/medusa#11704, fixed in PR #11714): it
 * fired inventory-item.updated instead of reservation-item.updated whenever a
 * reservation's quantity, line item, or location changed, whether from the
 * admin UI, the Admin API, or an internal workflow like order fulfillment or
 * cancellation. A subscriber registered for RESERVATION_ITEM_UPDATED never
 * receives that change, so a stock-sync integration built on it silently
 * drifts. This lists reservations per stock location, diffs their live
 * quantity against a last-synced snapshot, and cross-checks reserved_quantity
 * at each location level against the sum of live reservations there.
 * By default it only reports drift. Pass --apply (with DRY_RUN=false) to also
 * update the sync baseline and forward the corrected delta downstream.
 * Run as a scheduled reconciler. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/reservation-updated-event-not-firing/
 */
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SYNC_STATE_PATH = process.env.SYNC_STATE_PATH || "reservation_sync_state.json";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, quantity: number, location_id: string, updated_at: string }[]} live
 * @param {Record<string, { quantity: number, updated_at: string }>} lastSynced
 * @returns {{ id: string, drift: number, staleSince: string }[]}
 *
 * Returns one entry for every reservation whose live quantity diverged from
 * (or is missing from) the last-synced map, with the signed drift and how
 * long it has been stale. This is the exact recomputation a working
 * RESERVATION_ITEM_UPDATED subscriber would have done incrementally.
 */
export function diffReservationSync(live, lastSynced) {
  return live
    .filter((r) => {
      const prev = lastSynced[r.id];
      return !prev || prev.quantity !== r.quantity;
    })
    .map((r) => ({
      id: r.id,
      drift: r.quantity - (lastSynced[r.id]?.quantity ?? 0),
      staleSince: lastSynced[r.id]?.updated_at ?? r.updated_at,
    }));
}

/**
 * Pure decision function. No I/O.
 *
 * @param {Record<string, { quantity: number, inventory_item_id: string }[]>} reservationsByLocation
 * @param {{ location_id: string, reserved_quantity: number, inventory_item_id: string }[]} locationLevels
 * @returns {{ location_id: string, inventory_item_id: string, reserved_quantity: number, live_sum: number }[]}
 *
 * Flags a location level whose reserved_quantity does not equal the sum of
 * live reservation quantities for that location and inventory item.
 */
export function locationLevelMismatches(reservationsByLocation, locationLevels) {
  const mismatches = [];
  for (const level of locationLevels) {
    const liveReservations = reservationsByLocation[level.location_id] || [];
    const liveSum = liveReservations
      .filter((r) => r.inventory_item_id === level.inventory_item_id)
      .reduce((sum, r) => sum + r.quantity, 0);
    if (liveSum !== level.reserved_quantity) {
      mismatches.push({
        location_id: level.location_id,
        inventory_item_id: level.inventory_item_id,
        reserved_quantity: level.reserved_quantity,
        live_sum: liveSum,
      });
    }
  }
  return mismatches;
}

async function getAdminToken() {
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function adminGet(token, path, params = {}) {
  const url = new URL(`${BACKEND_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status} on GET ${path}`);
  return res.json();
}

async function listStockLocations(token) {
  const data = await adminGet(token, "/admin/stock-locations", { limit: 200 });
  return data.stock_locations;
}

async function listReservationsForLocation(token, locationId) {
  const reservations = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/reservations", {
      location_id: locationId,
      fields: "id,quantity,line_item_id,inventory_item_id,location_id,updated_at,*inventory_item",
      limit,
      offset,
    });
    reservations.push(...data.reservations);
    offset += limit;
    if (offset >= data.count) return reservations;
  }
}

async function fetchLocationLevels(token, inventoryItemId) {
  const data = await adminGet(token, `/admin/inventory-items/${inventoryItemId}/location-levels`);
  return data.inventory_item.location_levels;
}

async function loadSyncState(path) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function saveSyncState(path, state) {
  await writeFile(path, JSON.stringify(state, null, 2));
}

function forwardDelta(resId, drift) {
  // Push the corrected reserved delta to whatever external system this
  // stock-sync consumer feeds. Replace with a real integration call.
  console.log(`Forwarding corrected delta for ${resId}: ${drift >= 0 ? "+" : ""}${drift} to downstream stock system`);
}

export async function run() {
  const applyFlag = process.argv.includes("--apply");
  const token = await getAdminToken();
  const syncState = await loadSyncState(SYNC_STATE_PATH);

  const locations = await listStockLocations(token);
  const allReservations = [];
  const reservationsByLocation = {};
  for (const location of locations) {
    const resList = await listReservationsForLocation(token, location.id);
    reservationsByLocation[location.id] = resList;
    allReservations.push(...resList);
  }

  const drifted = diffReservationSync(allReservations, syncState);

  for (const entry of drifted) {
    console.warn(
      `Reservation ${entry.id} drifted (${entry.drift >= 0 ? "+" : ""}${entry.drift}) stale since ${entry.staleSince}. ${
        DRY_RUN || !applyFlag ? "Would update baseline" : "Updating baseline"
      }`
    );
    if (!DRY_RUN && applyFlag) {
      const live = allReservations.find((r) => r.id === entry.id);
      syncState[entry.id] = { quantity: live.quantity, updated_at: live.updated_at };
      forwardDelta(entry.id, entry.drift);
    }
  }

  const inventoryItemIds = new Set(allReservations.map((r) => r.inventory_item_id));
  const allMismatches = [];
  for (const iitemId of inventoryItemIds) {
    const levels = await fetchLocationLevels(token, iitemId);
    allMismatches.push(...locationLevelMismatches(reservationsByLocation, levels));
  }

  for (const mismatch of allMismatches) {
    console.warn(
      `Location level mismatch at ${mismatch.location_id} for ${mismatch.inventory_item_id}: reserved_quantity=${mismatch.reserved_quantity} live_sum=${mismatch.live_sum}`
    );
  }

  if (!DRY_RUN && applyFlag) {
    await saveSyncState(SYNC_STATE_PATH, syncState);
  }

  console.log(
    `Done. ${drifted.length} drifted reservation(s), ${allMismatches.length} location level mismatch(es). ${
      !DRY_RUN && applyFlag ? "Baseline updated" : "Report only"
    }.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
