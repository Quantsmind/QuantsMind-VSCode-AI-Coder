from fastapi import APIRouter
from app.models import User

router = APIRouter()


@router.get("/users")
def list_users():
    return [User("ada")]
