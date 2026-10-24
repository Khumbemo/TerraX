"""Server administration from the command line: ``python -m terrax.manage <command>``.

    create-user EMAIL [--admin] [--name NAME]   create an account (asks for the password, or reads TERRAX_NEW_PASSWORD)
    set-password EMAIL                          set a new password (signs the account out everywhere)
    set-role EMAIL user|admin                   change an account's role
    disable EMAIL / enable EMAIL                block or allow sign-in
    list-users                                  accounts, roles and last sign-in
    purge                                       delete expired uploads, results and old recorded errors now
    migrate status|upgrade                      the database's schema revision, or upgrade it (also done at start-up)
    check                                       database, storage and settings at a glance
    backup                                      back the database up now (to the bucket, or TERRAX_BACKUP_DIR)
    backups                                     list the stored backups, newest first
    restore NAME|FILE --yes                     replace every row of the database with a backup's
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import time

from sqlalchemy import delete, select, update

from . import auth, db, storage
from .config import settings
from .monitoring import purge_errors


def _password(confirm: bool = True) -> str:
    env = os.environ.get("TERRAX_NEW_PASSWORD")
    if env:
        return env
    pw = getpass.getpass("Password: ")
    if confirm and getpass.getpass("Again: ") != pw:
        sys.exit("The passwords differ.")
    return pw


def _user(email: str) -> dict:
    u = auth.user_by_email(email)
    if not u:
        sys.exit(f"There is no account {email}.")
    return u


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m terrax.manage", description="TerraX server administration.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user")
    c.add_argument("email")
    c.add_argument("--admin", action="store_true")
    c.add_argument("--name", default="")
    sub.add_parser("set-password").add_argument("email")
    r = sub.add_parser("set-role")
    r.add_argument("email")
    r.add_argument("role", choices=["user", "admin"])
    sub.add_parser("disable").add_argument("email")
    sub.add_parser("enable").add_argument("email")
    sub.add_parser("list-users")
    sub.add_parser("purge")
    sub.add_parser("migrate").add_argument("action", choices=["status", "upgrade"])
    sub.add_parser("check")
    sub.add_parser("backup")
    sub.add_parser("backups")
    rs = sub.add_parser("restore")
    rs.add_argument("name", help="a backup's name (from `backups`) or the path of a backup file")
    rs.add_argument("--yes", action="store_true", help="confirm: every row now in the database is replaced")
    a = ap.parse_args(argv)
    from fastapi import HTTPException

    try:
        if a.cmd == "create-user":
            u = auth.create_user(a.email, _password(), a.name, "admin" if a.admin else "user")
            print(f"Created {u['email']} ({u['role']}).")
        elif a.cmd == "set-password":
            auth.set_password(_user(a.email)["id"], _password())
            print("Password changed; the account was signed out everywhere.")
        elif a.cmd in ("set-role", "disable", "enable"):
            u = _user(a.email)
            values = {"role": a.role} if a.cmd == "set-role" else {"disabled": a.cmd == "disable"}
            with db.connect() as conn:
                conn.execute(update(db.users).where(db.users.c.id == u["id"]).values(**values))
                if a.cmd == "disable":
                    conn.execute(delete(db.sessions).where(db.sessions.c.user_id == u["id"]))
            print(f"{u['email']}: {values}")
        elif a.cmd == "list-users":
            with db.connect() as conn:
                for row in conn.execute(select(db.users).order_by(db.users.c.created)):
                    last = time.strftime("%Y-%m-%d %H:%M", time.localtime(row.last_login)) if row.last_login else "never"
                    print(f"{row.email:40s} {row.role:6s} {'disabled' if row.disabled else 'active':9s} last sign-in {last}")
        elif a.cmd == "migrate":
            from alembic.runtime.migration import MigrationContext
            from alembic.script import ScriptDirectory

            eng = db.engine() if a.action == "upgrade" else None  # engine() upgrades on first use
            from sqlalchemy import create_engine

            check = eng or create_engine(db.database_url())
            with check.connect() as conn:
                current = MigrationContext.configure(conn).get_current_revision()
            head = ScriptDirectory.from_config(db.alembic_config()).get_current_head()
            print(f"database revision {current or 'none'}; newest {head}{' (up to date)' if current == head else ''}")
        elif a.cmd == "backup":
            from . import backup

            made = backup.create()
            print(f"Backed up {sum(made['rows'].values())} rows to {made['name']} ({made['size']:,} bytes)" + (f"; removed {len(made['removed'])} older." if made["removed"] else "."))
        elif a.cmd == "backups":
            from . import backup

            for b in backup.list_backups():
                when = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(b["created"]))
                print(f"{b['name']}  {when}" + (f"  {b['size']:,} bytes" if b["size"] is not None else ""))
        elif a.cmd == "restore":
            from . import backup

            if not a.yes:
                sys.exit("Restoring replaces every row in the database (accounts, history, projects). Add --yes to go ahead.")
            try:
                n = backup.load(backup.read(a.name))
            except KeyError:
                sys.exit(f"There is no backup {a.name}; `python -m terrax.manage backups` lists them.")
            except ValueError as e:
                sys.exit(str(e))
            print(f"Restored {sum(n.values())} rows from {a.name}.")
        elif a.cmd == "purge":
            print(f"Removed {storage.purge_old()} expired folders and {purge_errors()} old error records.")
        elif a.cmd == "check":
            s = settings()
            print(f"database  {db.database_url().split('@')[-1]}  {'ok' if db.ping() else 'NOT REACHABLE'}")
            from . import objectstore

            bucket = f"; bucket {s.s3_bucket} ({'ok' if objectstore.ping() else 'NOT REACHABLE'})" if s.s3_bucket else "; no bucket (uploads live only on this disk)"
            print(f"storage   {s.storage_dir}{bucket}")
            print(f"backups   {'every ' + str(s.backup_hours) + ' h' if s.backup_hours else 'on demand only'}, keep {s.backup_keep}, to {'the bucket' if s.s3_bucket else s.backup_dir or s.storage_dir / 'backups'}")
            print(f"accounts  TERRAX_AUTH={s.auth_mode}, sign-up {s.signup}, {auth.count_admins()} active admin(s)")
            print(f"limits    {'on' if s.rate_limits else 'off'}: {s.jobs_per_minute} jobs/min, {s.uploads_per_hour} uploads/h; quota user {s.user_quota_mb} MB, guest {s.guest_quota_mb} MB")
            print(f"retention guests {s.retention_hours} h, accounts {s.user_retention_days or 'unlimited'} d")
            print(f"metrics   {'token set' if s.metrics_token else 'admins only'}; Sentry {'on' if s.sentry_dsn else 'off'}")
            if s.auth_mode != "required":
                print("note      anyone who can reach this server can use it as a guest; set TERRAX_AUTH=required on a public server.")
    except HTTPException as e:  # the same checks as the web API (password length, duplicate e-mail, …)
        sys.exit(str(e.detail))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
