from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]


def test_cards_route_has_query_aligned_indexes() -> None:
    migration_text = "\n".join(
        path.read_text()
        for path in sorted((ROOT / "pinai-agents" / "db" / "migrations").glob("*.sql"))
    )

    assert "idx_pai_pipeline_cards_completed" in migration_text
    assert "idx_pai_feedback_card_latest" in migration_text
