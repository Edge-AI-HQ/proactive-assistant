"""Voice identity profile repository."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .base import UserScopedRepository


@dataclass(slots=True)
class VoiceIdentityProfileRow:
    user_id: int
    enabled: bool
    speaker_name: str
    reference_storage_path: str
    reference_mime: str
    reference_byte_len: int
    reference_duration_ms: int
    reference_sha256: str
    enrolled_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict) -> VoiceIdentityProfileRow:
        return cls(
            user_id=int(row["user_id"]),
            enabled=bool(row["enabled"]),
            speaker_name=str(row["speaker_name"]),
            reference_storage_path=str(row["reference_storage_path"]),
            reference_mime=str(row["reference_mime"]),
            reference_byte_len=int(row["reference_byte_len"]),
            reference_duration_ms=int(row["reference_duration_ms"]),
            reference_sha256=str(row["reference_sha256"]),
            enrolled_at=row["enrolled_at"],
            updated_at=row["updated_at"],
        )


class VoiceIdentityRepository(UserScopedRepository):
    async def get_profile(self) -> VoiceIdentityProfileRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_voice_identity_profiles
                WHERE user_id = %s
                """,
                (self._user_id,),
            )
            row = await cur.fetchone()
        return VoiceIdentityProfileRow.from_record(row) if row else None

    async def upsert_profile(
        self,
        *,
        reference_storage_path: str,
        reference_mime: str,
        reference_byte_len: int,
        reference_duration_ms: int,
        reference_sha256: str,
    ) -> VoiceIdentityProfileRow:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_voice_identity_profiles (
                  user_id, enabled, speaker_name, reference_storage_path,
                  reference_mime, reference_byte_len, reference_duration_ms,
                  reference_sha256, enrolled_at, updated_at
                )
                VALUES (%s, TRUE, 'self', %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                  enabled = TRUE,
                  speaker_name = 'self',
                  reference_storage_path = EXCLUDED.reference_storage_path,
                  reference_mime = EXCLUDED.reference_mime,
                  reference_byte_len = EXCLUDED.reference_byte_len,
                  reference_duration_ms = EXCLUDED.reference_duration_ms,
                  reference_sha256 = EXCLUDED.reference_sha256,
                  enrolled_at = NOW(),
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    self._user_id,
                    reference_storage_path,
                    reference_mime,
                    reference_byte_len,
                    reference_duration_ms,
                    reference_sha256,
                ),
            )
            row = await cur.fetchone()
        if row is None:  # UPSERT ... RETURNING always yields a row
            msg = "voice identity upsert did not return a row"
            raise RuntimeError(msg)
        return VoiceIdentityProfileRow.from_record(row)

    async def set_enabled(self, enabled: bool) -> VoiceIdentityProfileRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_voice_identity_profiles
                SET enabled = %s, updated_at = NOW()
                WHERE user_id = %s
                RETURNING *
                """,
                (enabled, self._user_id),
            )
            row = await cur.fetchone()
        return VoiceIdentityProfileRow.from_record(row) if row else None

    async def delete_profile(self) -> None:
        await self._conn.execute(
            "DELETE FROM pai_voice_identity_profiles WHERE user_id = %s",
            (self._user_id,),
        )
