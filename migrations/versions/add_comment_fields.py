"""add comment fields

Revision ID: a1b2c3d4e5f6
Revises: 897dbfa81f80
Create Date: 2026-06-05 15:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = '897dbfa81f80'
branch_labels = None
depends_on = None


def upgrade():
    # 给 annotation_projects 表新增 comment_presets 字段
    op.add_column('annotation_projects', sa.Column('comment_presets', sa.Text(), nullable=True, comment='预设注释列表(JSON)'))

    # 给 annotations 表新增 comment 字段
    op.add_column('annotations', sa.Column('comment', sa.Text(), nullable=True, comment='注释说明（标注员填写的标准化注释）'))


def downgrade():
    op.drop_column('annotations', 'comment')
    op.drop_column('annotation_projects', 'comment_presets')
