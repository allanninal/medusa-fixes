# Dummy environment so the scripts import cleanly during tests.
# The tests only exercise pure functions, so no real credentials are ever used.
import os

os.environ.setdefault("MEDUSA_BACKEND_URL", "http://localhost:9000")
os.environ.setdefault("MEDUSA_ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("MEDUSA_ADMIN_PASSWORD", "supersecret")
os.environ.setdefault("MEDUSA_PUBLISHABLE_KEY", "pk_dummy")
os.environ.setdefault("DRY_RUN", "true")
