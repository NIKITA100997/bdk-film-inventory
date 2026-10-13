"""Заказы клиентов — отдельная сущность (13.10)

Revision ID: c3e5a7b9d1f2
Revises: b2d4f6a8c0e1
Create Date: 2026-10-13 10:00:00.000000

Заказ клиента = один счёт 1С (как в ERP: заказ покупателя → заказ на
производство): клиент, менеджер, сумма, приоритет, вилка отгрузки,
обещанные готовность и отгрузка, статус заявки, позиции. Начальник
производства собирает принятые заказы клиентов в заказ на производство
(запуск); строка заказа на производство ссылается на строку заказа
клиента. История переносов и снимок плана недели — по заказам клиентов.

Перенос: строки заказов на производство с номером счёта → заказ клиента
на счёт (принят производством), строки связываются.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3e5a7b9d1f2'
down_revision: Union[str, Sequence[str], None] = 'b2d4f6a8c0e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_orders",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("invoice_no", sa.String(64), nullable=False, unique=True),
        sa.Column("invoice_date", sa.Date, nullable=True),
        sa.Column("customer", sa.String(255), nullable=True),
        sa.Column("manager_id", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("amount_rub", sa.Numeric(14, 2), nullable=True),
        sa.Column("priority", sa.SmallInteger, nullable=False, server_default="0"),
        sa.Column("ship_from", sa.Date, nullable=True),
        sa.Column("ship_to", sa.Date, nullable=True),
        sa.Column("promised_ready", sa.Date, nullable=True),
        sa.Column("ship_date", sa.Date, nullable=True),
        sa.Column("ready_at", sa.Date, nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("request_comment", sa.String(500), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_by", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "customer_order_lines",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("order_id", sa.Integer, sa.ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("items.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False),
        sa.Column("note", sa.String(255), nullable=True),
        sa.Column("source_text", sa.String(500), nullable=True),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column("production_order_lines", sa.Column(
        "customer_order_line_id", sa.Integer, sa.ForeignKey("customer_order_lines.id", ondelete="SET NULL"), nullable=True, index=True))
    op.add_column("order_date_changes", sa.Column(
        "customer_order_id", sa.Integer, sa.ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=True, index=True))
    op.alter_column("order_date_changes", "order_id", nullable=True)
    op.add_column("production_plan_items", sa.Column("customer_order_id", sa.Integer, nullable=True))

    # перенос: строки со счётом → заказ клиента на счёт, принятый производством
    conn = op.get_bind()
    rows = conn.execute(sa.text("""
        select l.id, l.item_id, l.quantity, l.note, l.source_text, l.invoice_no,
               o.customer, o.priority, o.ship_date, o.promised_ready, o.created_by
        from production_order_lines l join production_orders o on o.id = l.order_id
        where l.invoice_no is not null order by l.order_id, l.sort_order, l.id
    """)).fetchall()
    co_ids: dict[str, int] = {}
    sort: dict[str, int] = {}
    for r in rows:
        inv = r.invoice_no.strip()
        if inv not in co_ids:
            co_ids[inv] = conn.execute(sa.text("""
                insert into customer_orders (invoice_no, customer, manager_id, priority, promised_ready, ship_date, status, created_by, note)
                values (:inv, :cust, :mgr, :pr, :ready, :ship, 'accepted', :mgr, 'перенесён из заказа на производство 13.10')
                returning id
            """), dict(inv=inv, cust=r.customer, mgr=r.created_by, pr=r.priority or 0, ready=r.promised_ready, ship=r.ship_date)).scalar()
            sort[inv] = 0
        sort[inv] += 1
        lid = conn.execute(sa.text("""
            insert into customer_order_lines (order_id, item_id, quantity, note, source_text, sort_order)
            values (:o, :i, :q, :n, :s, :so) returning id
        """), dict(o=co_ids[inv], i=r.item_id, q=r.quantity, n=r.note, s=r.source_text, so=sort[inv])).scalar()
        conn.execute(sa.text("update production_order_lines set customer_order_line_id = :c where id = :l"), dict(c=lid, l=r.id))


def downgrade() -> None:
    op.drop_column("production_plan_items", "customer_order_id")
    op.execute("delete from order_date_changes where order_id is null")
    op.alter_column("order_date_changes", "order_id", nullable=False)
    op.drop_column("order_date_changes", "customer_order_id")
    op.drop_column("production_order_lines", "customer_order_line_id")
    op.drop_table("customer_order_lines")
    op.drop_table("customer_orders")
