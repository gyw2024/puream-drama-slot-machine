"""Read-only sampled-face / dense AV speaker evidence; no automatic pass claims.

Uses the MIT TalkNet-ASD authors' pretrained TalkSet model and crop convention.
Does not execute their demo shell commands or download during import.
"""
import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path


def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('video')
    parser.add_argument('--repo', required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--device', choices=['auto', 'cpu', 'cuda'], default='auto')
    args = parser.parse_args()
    import cv2
    import numpy as np
    import torch
    import python_speech_features
    from scipy.io import wavfile
    from scipy.signal import medfilt
    sys.path.insert(0, str(Path(args.repo).resolve()))
    from model.faceDetector.s3fd import S3FD
    from model.talkNetModel import talkNetModel
    from loss import lossAV
    torch.set_num_threads(4)
    device = 'cuda' if args.device == 'auto' and torch.cuda.is_available() else ('cpu' if args.device == 'auto' else args.device)
    if device == 'cuda':
        try:
            torch.zeros(1, device='cuda')
        except (RuntimeError, AssertionError):
            if args.device != 'auto':
                raise
            device = 'cpu'
            print(json.dumps({'stage': 'runtime', 'warning': 'CUDA initialization unavailable; using CPU'}), file=sys.stderr, flush=True)
    print(json.dumps({'stage': 'runtime', 'device': device, 'torch': torch.__version__}), file=sys.stderr, flush=True)
    original = Path(args.video).resolve(strict=True)
    source_hash = digest(original)
    output = Path(args.output).resolve() / source_hash
    output.mkdir(parents=True, exist_ok=True)
    normalized, wav = output / 'audit-25fps.mp4', output / 'audit-16k.wav'
    def ffmpeg(arguments):
        subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', *arguments],
                       check=True, timeout=120, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if not normalized.exists():
        ffmpeg(['-i', str(original), '-an', '-vf', 'fps=25,scale=640:640:force_original_aspect_ratio=decrease',
                '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', str(normalized)])
    if not wav.exists():
        ffmpeg(['-i', str(original), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav)])
    cap = cv2.VideoCapture(str(normalized))
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()
    if not 10 <= len(frames) <= 1500:
        raise RuntimeError('Expected one video unit of at most 60 seconds')
    detector = S3FD(device=device)
    tracks = []
    def iou(a, b):
        xy1, xy2 = np.maximum(a[:2], b[:2]), np.minimum(a[2:], b[2:])
        intersection = np.maximum(0, xy2 - xy1).prod()
        return intersection / max(1, (a[2:] - a[:2]).prod() + (b[2:] - b[:2]).prod() - intersection)
    for index in range(0, len(frames), 4):
        # Detector is sampled; face pixels used by TalkNet below remain 25 fps.
        boxes = detector.detect_faces(cv2.cvtColor(frames[index], cv2.COLOR_BGR2RGB), conf_th=0.85, scales=[1])
        used = set()
        for detected in boxes:
            box = np.array(detected[:4])
            matches = [(iou(t['boxes'][-1], box), n) for n, t in enumerate(tracks)
                       if n not in used and index-t['frames'][-1] <= 4]
            score, owner = max(matches, default=(0, -1))
            if score < 0.35:
                owner = len(tracks)
                tracks.append({'frames': [], 'boxes': []})
            used.add(owner)
            tracks[owner]['frames'].append(index)
            tracks[owner]['boxes'].append(box)
        if index % 100 == 0:
            print(json.dumps({'stage':'face_tracks','frame':index,'total':len(frames)}), file=sys.stderr, flush=True)
    weights_path = Path(args.repo) / 'pretrain_TalkSet.model'
    weights = torch.load(weights_path, map_location='cpu', weights_only=True)
    network, classifier = talkNetModel().eval().to(device), lossAV().eval().to(device)
    network.load_state_dict({k[6:]: v for k, v in weights.items() if k.startswith('model.')}, strict=True)
    classifier.load_state_dict({k[7:]: v for k, v in weights.items() if k.startswith('lossAV.')}, strict=True)
    rate, audio = wavfile.read(wav)
    if rate != 16000:
        raise RuntimeError('Audio rate mismatch')
    result = []
    for track in tracks:
        if len(track['frames']) < 4:
            continue
        first, last = track['frames'][0], track['frames'][-1]
        indices = np.arange(first, last+1)
        boxes = np.stack([np.interp(indices, track['frames'], np.array(track['boxes'])[:, k]) for k in range(4)], axis=1)
        size = medfilt(np.maximum(boxes[:, 2]-boxes[:, 0], boxes[:, 3]-boxes[:, 1])/2, 13)
        xs, ys = medfilt((boxes[:, 0]+boxes[:, 2])/2, 13), medfilt((boxes[:, 1]+boxes[:, 3])/2, 13)
        images = []
        for j, index in enumerate(indices):
            bs = max(1, size[j]); pad = int(bs*1.8)
            frame = np.pad(frames[index], ((pad,pad),(pad,pad),(0,0)), constant_values=110)
            x, y = xs[j]+pad, ys[j]+pad
            crop = frame[int(y-bs):int(y+bs*1.8), int(x-bs*1.4):int(x+bs*1.4)]
            gray = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (224,224))[56:168,56:168]
            images.append(gray)
        mfcc = python_speech_features.mfcc(audio[first*640:(last+1)*640], 16000, numcep=13, winlen=.025, winstep=.010)
        count = min(len(images), len(mfcc)//4)
        if count < 10:
            continue
        all_scores = []
        for seconds in [1, 2, 4]:
            scores = []
            for offset in range(0, count, seconds*25):
                end = min(count, offset+seconds*25)
                with torch.inference_mode():
                    a = torch.tensor(mfcc[offset*4:end*4],dtype=torch.float32,device=device).unsqueeze(0)
                    v = torch.tensor(np.array(images[offset:end]),dtype=torch.float32,device=device).unsqueeze(0)
                    a, v = network.forward_audio_frontend(a), network.forward_visual_frontend(v)
                    a, v = network.forward_cross_attention(a, v)
                    scores.extend(classifier(network.forward_audio_visual_backend(a,v)).tolist())
            all_scores.append(scores[:count])
        scores = np.mean(np.array(all_scores),axis=0)
        track_id = f'T{len(result)+1:02d}'
        midpoint = len(indices)//2
        preview = output / f'{track_id}-face.jpg'
        box = boxes[midpoint].round().astype(int); h,w=frames[indices[midpoint]].shape[:2]
        x1,y1=max(0,box[0]),max(0,box[1]);x2,y2=min(w,box[2]),min(h,box[3])
        cv2.imencode('.jpg',frames[indices[midpoint]][y1:y2,x1:x2])[1].tofile(preview)
        result.append({'trackId':track_id,'start':first/25,'end':(first+count)/25,'preview':str(preview),
                       'detectedFrames':track['frames'],'boxes':np.round(boxes,1).tolist(),
                       'scores':[{'time':round((first+i)/25,3),'audibleSpeakingLogit':round(float(v),3)} for i,v in enumerate(scores)]})
        print(json.dumps({'stage':'active_speaker','trackId':track_id,'frames':count}),file=sys.stderr,flush=True)
    report = {'sourceSha256':source_hash,'sourcePath':str(original),'modelSha256':digest(weights_path),
              'method':'TalkNet-ASD TalkSet pretrained; 25fps actual face pixels + aligned actual 16k audio',
              'tracks':result,'createdAt':time.time(),
              'runtime':{'device':device,'torchVersion':torch.__version__,'cudaVersion':torch.version.cuda},
              'limitations':['Raw model logits are evidence, not calibrated certainty or manual listening.',
                             'Track IDs need visual identity comparison; they are not character IDs.',
                             'Face detection occurs every four frames and intermediate boxes are interpolated.',
                             'Prosody, dialogue wording and all undetected faces remain separate checks.']}
    (output/'active-speaker.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'report':str(output/'active-speaker.json'),'tracks':len(result),'sourceSha256':source_hash}))


if __name__ == '__main__':
    main()
