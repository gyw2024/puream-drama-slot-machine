"""Read-only media audit. Tiny ASR is a screening aid, never a speaker/QC verdict."""
import json
import sys
import re
from pathlib import Path
from difflib import SequenceMatcher
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

root = Path(sys.argv[1])
records = json.loads((root / "video-audit.json").read_text(encoding="utf-8"))["records"]
model = WhisperModel("tiny", device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
result = []
def norm(text):
    return re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", text).lower()
for record in records:
    samples = decode_audio(record["videoPath"], sampling_rate=16000)
    segments, info = model.transcribe(samples, language="zh", beam_size=5, word_timestamps=True,
                                      condition_on_previous_text=False, vad_filter=True)
    segments = list(segments)
    text = "".join(s.text for s in segments)
    expected = re.sub(r"C\d+:", "", record["dialogue"])
    similarity = SequenceMatcher(None, norm(expected), norm(text)).ratio()
    frame = 160
    rms = [float(np.sqrt(np.mean(samples[i:i+frame] ** 2))) for i in range(0, min(len(samples), 16000), frame)]
    # A pulse alone can be a footstep/prop sound. Never label it as mouth noise.
    onset_pulse = any(rms[i] > 0.03 and i + 8 < len(rms) and max(rms[i+3:i+8]) < rms[i] * 0.12 for i in range(min(85, len(rms))))
    item = {"shotId": record["shotId"], "videoPath": record["videoPath"],
            "model": "faster-whisper-tiny-local", "expected": expected, "recognized": text,
            "similarity": round(similarity, 3), "onsetPulseCandidate": onset_pulse,
            "speechReviewStatus": "unverified: ASR screening only; speaker, emotion and noise require listening",
            "segments": [{"start": s.start, "end": s.end, "text": s.text,
                          "averageLogProbability": s.avg_logprob,
                          "words": [{"start": w.start, "end": w.end, "word": w.word, "probability": w.probability} for w in (s.words or [])]} for s in segments]}
    result.append(item)
    (root / "audio-screening.json").write_text(json.dumps({"complete": len(result)==len(records), "count":len(result), "records":result}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"shotId":item["shotId"],"similarity":item["similarity"],"onsetPulseCandidate":onset_pulse}, ensure_ascii=False), flush=True)
