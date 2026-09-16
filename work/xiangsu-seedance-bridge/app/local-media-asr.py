"""Read-only local recognition. Never feed the expected script as a prompt."""
import argparse
import hashlib
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("media")
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    args = parser.parse_args()
    from faster_whisper import WhisperModel
    import numpy as np
    from faster_whisper.audio import decode_audio
    model = WhisperModel(args.model, device=args.device,
                         compute_type="int8" if args.device == "cpu" else "int8_float16",
                         local_files_only=True, cpu_threads=4)
    audio = decode_audio(args.media, sampling_rate=16000)
    segments, info = model.transcribe(audio, language="zh", beam_size=5,
                                      word_timestamps=True, vad_filter=True,
                                      condition_on_previous_text=False,
                                      vad_parameters={"min_silence_duration_ms": 250})
    rows = []
    words = []
    for segment in segments:
        rows.append({"start": segment.start, "end": segment.end,
                     "text": segment.text, "noSpeechProbability": segment.no_speech_prob,
                     "averageLogProbability": segment.avg_logprob})
        for word in segment.words or []:
            words.append({"word": word.word, "start": word.start,
                          "end": word.end, "probability": word.probability})
    envelope = []
    # Acoustic evidence is not a noise classifier and must not authorize trims.
    for start in range(0, min(len(audio), 32000), 160):
        window = audio[start:start + 160]
        envelope.append({"start": start / 16000,
                         "rms": float(np.sqrt(np.mean(window * window))),
                         "peak": float(np.max(np.abs(window)))})
    digest = hashlib.sha256()
    with open(args.media, "rb") as media:
        for chunk in iter(lambda: media.read(1024 * 1024), b""):
            digest.update(chunk)
    result = {"source": "local-faster-whisper", "sourceSha256": digest.hexdigest(),
              "model": os.path.basename(args.model), "device": args.device,
              "generated": False, "duration": len(audio) / 16000,
              "language": info.language, "text": "".join(row["text"] for row in rows),
              "segments": rows, "words": words, "openingEnvelope": envelope,
              "limitations": ["Recognition is not speaker identification or emotion listening.",
                              "ASR mismatch requires review; do not replace it with the script."]}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        main()
    except Exception as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False))
        sys.exit(1)
