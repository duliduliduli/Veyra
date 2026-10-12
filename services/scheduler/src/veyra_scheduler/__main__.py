import argparse
import logging
import threading
import time

from veyra_api import config
from veyra_api.db import Database, migrate
from veyra_api.storage import ObjectStore

from veyra_scheduler.reaper import ReapCursor, reap_expired, reap_unused_authorizations
from veyra_scheduler.worker import Worker, require_local_worker

log = logging.getLogger("veyra.reaper")


def main() -> None:
    parser = argparse.ArgumentParser(prog="veyra-scheduler")
    parser.add_argument("mode", choices=["worker", "reaper", "all"], default="all", nargs="?")
    parser.add_argument("--poll", type=float, default=1.0)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    settings = config.load()
    if args.mode in ("worker", "all"):
        require_local_worker(settings)
    migrate(settings.database_url)
    database = Database(settings.database_url, max_size=4)

    def reaper_loop():
        paths = (("reap_expired", reap_expired, ReapCursor()),
                 ("reap_unused_authorizations", reap_unused_authorizations, ReapCursor()))
        while True:
            for name, reap, cursor in paths:
                try:
                    reap(database, cursor=cursor)
                except Exception as exc:
                    # Exception text and tracebacks can expose database configuration.
                    log.error("%s failed (%s); retrying next interval", name, type(exc).__name__)
            time.sleep(max(settings.job_lease_seconds / 2, 1))

    if args.mode in ("reaper", "all"):
        t = threading.Thread(target=reaper_loop, daemon=True)
        t.start()
        if args.mode == "reaper":
            t.join()
    if args.mode in ("worker", "all"):
        Worker(database, ObjectStore(settings.object_store_dir), settings).run_forever(args.poll)


if __name__ == "__main__":
    main()
