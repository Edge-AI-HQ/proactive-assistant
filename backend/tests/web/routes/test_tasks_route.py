from pinai_api.domains.generation.tasks import _result_from_progress


def test_result_from_progress_preserves_fanout_counts():
    result = _result_from_progress(
        "succeeded",
        {
            "rawInserted": 590,
            "perToolkit": {
                "gmail": {"fetched": 100, "rawInserted": 100},
                "googlecalendar": {"fetched": 150, "rawInserted": 150},
                "googledrive": {"fetched": 200, "rawInserted": 200},
                "googledocs": {"fetched": 80, "rawInserted": 80},
                "googlesheets": {"fetched": 60, "rawInserted": 60},
            },
        },
    )

    assert result == {
        "rawInserted": 590,
        "memoriesWritten": 0,
        "skillsAdded": 0,
        "perToolkit": {
            "gmail": {"fetched": 100, "rawInserted": 100},
            "googlecalendar": {"fetched": 150, "rawInserted": 150},
            "googledrive": {"fetched": 200, "rawInserted": 200},
            "googledocs": {"fetched": 80, "rawInserted": 80},
            "googlesheets": {"fetched": 60, "rawInserted": 60},
        },
    }
