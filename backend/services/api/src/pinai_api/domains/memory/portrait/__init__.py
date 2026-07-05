"""⑤ Portrait — L2 常驻画像:存储 + hermes 编辑 + 注入组装(design doc 七节)。

五个 §-分隔 slot(IDENTITY/SOUL/TOOLS/USER/GOALS)的唯一信任写口:
memory_edit 经 api 面走 UserStringsRepository.edit(OCC 乐观锁 + 超预算
回吐 + 写时威胁扫描)。组装注入在 engine 侧(prompts/portrait + 中间件,
AGENTS 安全常量不入库)。

接口稳定性:memory_edit 工具面 frozen;repository 面 stable。
藏在模块内的决策(可自由改):hermes 编辑语义、OCC、预算、威胁扫描、注入顺序。
"""

from .repository import EditOp, EditResult, UserStringsRepository
from .seed import seed_default_goals

__all__ = ["EditOp", "EditResult", "UserStringsRepository", "seed_default_goals"]
