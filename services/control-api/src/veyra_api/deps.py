from fastapi import Depends, Request
from veyra_api.auth import Principal, authenticate
from veyra_api.config import Settings
from veyra_api.db import Database
from veyra_api.storage import ObjectStore


def db(request: Request) -> Database:
    return request.app.state.db


def store(request: Request) -> ObjectStore:
    return request.app.state.store


def settings(request: Request) -> Settings:
    return request.app.state.settings


CurrentUser = Depends(authenticate)
__all__ = ["CurrentUser", "Principal", "db", "settings", "store"]
