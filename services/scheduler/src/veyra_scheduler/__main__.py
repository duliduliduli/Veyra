import argparse
import logging
import threading
import time

from veyra_api import config
from veyra_api.db import Database, migrate
from veyra_api.storage import ObjectStore

from veyra_scheduler.reaper import reap_expired
from veyra_scheduler.worker import Worker


def main() -> None:
    parser = argparse.ArgumentParser(prog="veyra-scheduler")
    parser.add_argument("mode", choices=["worker", "reaper", "all"], default="all", nargs="?")
    parser.add_argument("--poll", type=float, default=1.0)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    settings = config.load()
    migrate(settings.database_url)
    database = Database(settings.database_url, max_size=4)

    def reaper_loop():
        while True:
            reap_expired(database)
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
