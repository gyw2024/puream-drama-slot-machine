"""Read the installed Harness adapter catalog without sending a prompt."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading


def main():
    from deepseek_harness_runtime import resolve_bundled_launch_args
    with tempfile.TemporaryDirectory(prefix="puream-models-") as directory:
        folder = pathlib.Path(directory)
        home = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else str(folder / "home")
        plugin = folder / "catalog.mjs"
        plugin.write_text("export const inject=['llm']; export function apply(ctx){let n=0;const read=async()=>{try{const models=await ctx.llm.listModels('deepseek-official');process.stdout.write('PUREAM_MODELS='+JSON.stringify(models)+'\\n',()=>process.exit(0));}catch{if(++n<30)setTimeout(read,100);else process.exit(2);}};setTimeout(read,100);}", encoding="utf-8")
        patch = folder / "catalog.json"
        patch.write_text(json.dumps([{"insert": [{"id": "puream-model-catalog", "name": plugin.as_uri()}]}]), encoding="utf-8")
        env = dict(os.environ, DSH_HOME=home)
        process = subprocess.Popen([*resolve_bundled_launch_args(), "--profile", "sdk", "--patch", str(patch)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        timer = threading.Timer(10, lambda: process.kill() if process.poll() is None else None)
        timer.start()
        try:
            for line in process.stdout:
                if line.startswith("PUREAM_MODELS="):
                    rows = json.loads(line[len("PUREAM_MODELS="):])
                    print(json.dumps([{"id": r["id"], "label": r.get("name", r["id"])} for r in rows]), flush=True)
                    return
            raise RuntimeError("Harness model catalog unavailable")
        finally:
            timer.cancel()
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)


if __name__ == "__main__":
    main()
