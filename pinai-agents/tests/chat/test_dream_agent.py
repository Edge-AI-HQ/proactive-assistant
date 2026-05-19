from pinai_agents.chat.agents.dream import _final_message_text


class _Message:
    def __init__(self, content):
        self.content = content


def test_final_message_text_extracts_langchain_text_blocks():
    final = _Message([
        {
            "type": "text",
            "text": (
                "```json\n"
                '{"memoriesWritten":1,"summary":"Daily context covered."}\n'
                "```"
            ),
        },
    ])

    text = _final_message_text(final)

    assert text.startswith("```json")
    assert '"summary":"Daily context covered."' in text
