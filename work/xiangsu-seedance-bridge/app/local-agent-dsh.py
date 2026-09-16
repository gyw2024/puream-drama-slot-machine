"""Official DeepSeek Harness SDK bridge. Credentials remain in the selected home."""
import json
import pathlib
import sys


def main():
    from deepseek_harness import DeepSeekHarness
    request_path = pathlib.Path(sys.argv[1]).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    prompt = request_path.with_name("TASK.txt").read_text(encoding="utf-8")
    kwargs = {"dsh_home": sys.argv[2], "cwd": str(request_path.parent)}
    if len(sys.argv) > 3 and sys.argv[3]:
        kwargs["model"] = sys.argv[3]
    if len(sys.argv) > 4 and sys.argv[4]:
        kwargs["reasoning_effort"] = sys.argv[4]
    with DeepSeekHarness(**kwargs) as harness:
        result = harness.run(prompt, session_id=request["jobId"])
        reason = getattr(result, "finish_reason", None)
        if reason != "completed":
            raise RuntimeError("Harness did not complete: " + str(reason))
        print(json.dumps({"type": "result", "result": result.final_response}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
