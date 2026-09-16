"""Unprompted waveform evidence. No expected dialogue or desired emotion input."""
import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path


def sha(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('media')
    parser.add_argument('--model', required=True)
    parser.add_argument('--recognition', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    import numpy as np
    import librosa
    import torch
    from faster_whisper.audio import decode_audio
    from funasr_onnx import SenseVoiceSmall
    import funasr_onnx.sensevoice_bin as sensevoice_runtime
    from funasr_onnx.utils.sentencepiece_tokenizer import SentencepiecesTokenizer
    import sentencepiece as spm
    class UnicodePathTokenizer(SentencepiecesTokenizer):
        def _build_sentence_piece_processor(self):
            if self.sp is None:
                # Some Windows SentencePiece wheels pass UTF-8 filenames to a
                # narrow C++ file API. Python reads the same bytes correctly.
                self.sp = spm.SentencePieceProcessor(model_proto=Path(self.bpemodel).read_bytes())
    sensevoice_runtime.SentencepiecesTokenizer = UnicodePathTokenizer
    torch.set_num_threads(4)
    source_hash = sha(args.media)
    recognition = json.loads(Path(args.recognition).read_text(encoding='utf-8'))
    if recognition.get('sourceSha256') != source_hash:
        raise RuntimeError('Recognition does not belong to these exact media bytes')
    waveform = decode_audio(args.media, sampling_rate=16000)
    duration = len(waveform) / 16000
    if not 0 < duration <= 60:
        raise RuntimeError('Single shot required')
    model = SenseVoiceSmall(args.model, quantize=True, batch_size=1, intra_op_num_threads=4)
    windows = [{'kind': 'whole_clip', 'start': 0, 'end': duration},
               {'kind': 'opening', 'start': 0, 'end': min(1.5, duration)}]
    windows.extend({'kind': 'unprompted_asr_segment', 'start': row['start'], 'end': row['end']}
                   for row in recognition.get('segments', []))
    started = time.time()
    rows = []
    for window in windows:
        start, end = max(0, window['start']), min(duration, window['end'])
        samples = waveform[round(start * 16000):round(end * 16000)]
        if len(samples) < 800:
            continue
        raw = model(samples, language='auto', textnorm='woitn')[0]
        tags = re.findall(r'<\|([^|]+)\|>', raw)
        # Measurements are waveform-derived, not an affect pass/fail oracle.
        rms = librosa.feature.rms(y=samples, frame_length=400, hop_length=160)[0]
        voiced = rms > max(0.008, float(np.max(rms)) * .15)
        pitch = librosa.yin(samples, fmin=65, fmax=500, sr=16000, frame_length=1024, hop_length=160)
        usable = pitch[:min(len(pitch), len(voiced))][voiced[:min(len(pitch), len(voiced))]]
        rows.append({**window, 'rawAudioModelOutput': raw, 'predictedTags': tags,
                     'rmsDb': float(20 * np.log10(max(1e-9, np.sqrt(np.mean(samples * samples))))),
                     'peak': float(np.max(np.abs(samples))),
                     'clippedFraction': float(np.mean(np.abs(samples) >= .999)),
                     'estimatedPitchHzP10P50P90': [float(x) for x in np.percentile(usable, [10, 50, 90])] if len(usable) else [],
                     'interpretation': 'Fallible audio-model classifications and acoustic measurements, not human listening or exact character identity.'})
    result = {'version': 'unprompted-audio-performance-v1', 'sourceSha256': source_hash,
              'modelSha256': sha(Path(args.model) / 'model_quant.onnx'), 'source': 'iic/SenseVoiceSmall-onnx',
              'duration': duration, 'elapsedSeconds': time.time() - started, 'windows': rows,
              'expectedDialogueProvidedToModel': False, 'humanListeningPerformed': False,
              'limitations': ['Coarse emotion labels do not prove every intended intonation beat.',
                              'Opening event classifications can mistake ambience for a vocal event; never trim through speech based on them alone.',
                              'This model does not identify which visible character owns a voice.']}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(output), 'sourceSha256': source_hash, 'elapsedSeconds': result['elapsedSeconds'],
                      'windows': [{'start': r['start'], 'end': r['end'], 'raw': r['rawAudioModelOutput']} for r in rows]}, ensure_ascii=False))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
