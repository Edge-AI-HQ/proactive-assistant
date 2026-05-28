from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.voice_identity import VoiceIdentityRepository
from pinai_agents.web.db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


async def test_upsert_get_disable_and_delete_profile(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = VoiceIdentityRepository(user_a, conn)
        created = await repo.upsert_profile(
            reference_storage_path="user-a/voice_identity/self_reference.wav",
            reference_mime="audio/wav",
            reference_byte_len=1234,
            reference_duration_ms=5000,
            reference_sha256="a" * 64,
        )

        assert created.enabled is True
        assert created.speaker_name == "self"
        assert created.reference_duration_ms == 5000

        disabled = await repo.set_enabled(False)
        assert disabled is not None
        assert disabled.enabled is False

        fetched = await repo.get_profile()
        assert fetched is not None
        assert fetched.reference_storage_path == "user-a/voice_identity/self_reference.wav"
        assert fetched.updated_at >= fetched.enrolled_at

        await repo.delete_profile()
        assert await repo.get_profile() is None


async def test_upsert_replaces_reference_and_reenables(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = VoiceIdentityRepository(user_a, conn)
        await repo.upsert_profile(
            reference_storage_path="user-a/voice_identity/self_reference.wav",
            reference_mime="audio/wav",
            reference_byte_len=1000,
            reference_duration_ms=3000,
            reference_sha256="a" * 64,
        )
        await repo.set_enabled(False)

        updated = await repo.upsert_profile(
            reference_storage_path="user-a/voice_identity/self_reference.wav",
            reference_mime="audio/wav",
            reference_byte_len=2000,
            reference_duration_ms=7000,
            reference_sha256="b" * 64,
        )

    assert updated.enabled is True
    assert updated.reference_byte_len == 2000
    assert updated.reference_duration_ms == 7000
    assert updated.reference_sha256 == "b" * 64


async def test_duration_check_is_enforced(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = VoiceIdentityRepository(user_a, conn)
        with pytest.raises(Exception, match="reference_duration_ms"):
            await repo.upsert_profile(
                reference_storage_path="user-a/voice_identity/self_reference.wav",
                reference_mime="audio/wav",
                reference_byte_len=1000,
                reference_duration_ms=1500,
                reference_sha256="a" * 64,
            )


async def test_profile_is_user_scoped(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await VoiceIdentityRepository(user_a, conn).upsert_profile(
            reference_storage_path="user-a/voice_identity/self_reference.wav",
            reference_mime="audio/wav",
            reference_byte_len=1000,
            reference_duration_ms=5000,
            reference_sha256="a" * 64,
        )

    async with user_scoped_tx(pool, user_b) as conn:
        assert await VoiceIdentityRepository(user_b, conn).get_profile() is None
