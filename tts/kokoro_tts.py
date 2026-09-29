"""Kokoro-82M text-to-speech for TTYNG Studio. Called by src/tts/kokoro.ts; not a user-facing tool.

stdin:  {"model_id": "hexgrad/Kokoro-82M",
         "jobs": [{"text": "...", "voice": "am_michael", "speed": 1.0, "out": "/abs/path.wav"}]}
stdout: {"results": [{"tokens": [{"text": "Your", "start": 0.375, "end": 0.537}, ...]}]}

Token times come from the model's own duration predictor, so they are the timings the audio was
made with. Times are seconds from the start of the job's audio. Logs and warnings go to stderr.
"""

import json
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from kokoro import KPipeline  # noqa: E402

SAMPLE_RATE = 24000
SEED = 0  # the vocoder adds noise; a fixed seed per job makes re-renders byte-identical


def main() -> None:
    request = json.load(sys.stdin)
    pipelines: dict[str, KPipeline] = {}
    results = []
    for job in request["jobs"]:
        lang = job["voice"][0]  # voice ids start with their language: a = American, b = British
        if lang not in pipelines:
            pipelines[lang] = KPipeline(lang_code=lang, repo_id=request["model_id"])
        torch.manual_seed(SEED)
        chunks, tokens, offset = [], [], 0.0
        for result in pipelines[lang](job["text"], voice=job["voice"], speed=job["speed"]):
            audio = result.audio.numpy()
            for t in result.tokens or []:
                timed = t.start_ts is not None and t.end_ts is not None
                tokens.append({
                    "text": t.text,
                    "start": round(t.start_ts + offset, 4) if timed else None,
                    "end": round(t.end_ts + offset, 4) if timed else None,
                })
            chunks.append(audio)
            offset += len(audio) / SAMPLE_RATE
        if not chunks:
            raise SystemExit(f"kokoro produced no audio for voice {job['voice']}")
        sf.write(job["out"], np.concatenate(chunks), SAMPLE_RATE, subtype="PCM_16")
        results.append({"tokens": tokens})
    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
