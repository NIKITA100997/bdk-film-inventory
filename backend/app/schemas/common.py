from datetime import datetime, timezone
from typing import Annotated

from pydantic import AfterValidator


def _reject_future(v: datetime | None) -> datetime | None:
    if v is not None:
        now = datetime.now(timezone.utc)
        aware = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        if aware > now:
            raise ValueError("Дата операции не может быть в будущем")
    return v


# Раздел про дату операции задним числом — необязательное поле у запросов
# всех операций, пишущих в журнал движений (record_event). None означает
# "сейчас", как и раньше; единственная валидация — не в будущем.
OccurredAt = Annotated[datetime | None, AfterValidator(_reject_future)]
