"""корзина заказа плёнки (22.10)

Из «Остатков» плёнку заказывают метрами: кладут в корзину и отправляют
заявку закупщику, он сводит заявки в заказ поставщику. У заявки — метры
и ширина рулона (м² считаются из них, вся прежняя логика — по м²).
Новое право «Заказ плёнки (корзина)» — тем, кто следит за остатком.

Revision ID: a831d1095a22
Revises: 132f74e8da83
Create Date: 2026-10-22 12:30:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = "a831d1095a22"
down_revision = "132f74e8da83"
branch_labels = None
depends_on = None

CODE = "purchasing.request"
ROLES = ("Оператор склада", "Начальник цеха", "Логист/руководитель", "Снабженец/закупщик")


def upgrade() -> None:
    op.add_column("purchase_requests", sa.Column("requested_length_m", sa.Numeric(12, 2), nullable=True))
    op.add_column("purchase_requests", sa.Column("width_mm", sa.Numeric(10, 2), nullable=True))
    op.execute(sa.text(
        "INSERT INTO permissions (code, name, section) VALUES (:c, :n, 'Закупки') ON CONFLICT (code) DO NOTHING"
    ).bindparams(c=CODE, n="Заказ плёнки: корзина в «Остатках» и заявка закупщику"))
    op.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission_id) "
        "SELECT r.id, p.id FROM roles r, permissions p WHERE p.code = :c AND r.name = ANY(:roles) "
        "AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)"
    ).bindparams(c=CODE, roles=list(ROLES)))


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = :c)").bindparams(c=CODE))
    op.execute(sa.text("DELETE FROM permissions WHERE code = :c").bindparams(c=CODE))
    op.drop_column("purchase_requests", "width_mm")
    op.drop_column("purchase_requests", "requested_length_m")
