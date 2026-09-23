#!/usr/bin/env python3
"""
VLM Visitor-Photo Quality Gate — self-hosted, runs on localhost:5065.

NOTE: port 5060 was the original choice but Node's fetch() (undici) hard-
blocks it — 5060/5061 are on the WHATWG Fetch spec's "forbidden ports" list
(reserved for SIP) and any fetch() call to them fails with "bad port"
regardless of what's actually listening. 5065 avoids that list entirely.

Called by visitorValidationService.js (via vlmQualityGateService.js) right
before a buffered visitor sighting is promoted to the `person` table. Judges
whether a photo actually shows one clear, unobstructed, correctly-captured
human face — as opposed to blurry / occluded / no-face / bad-crop frames that
shouldn't become (or overwrite) a visitor's stored photo.

Deliberately self-hosted (not a cloud VLM API): these are biometric visitor
photos and must never leave our own infrastructure.

Model: vikhyatk/moondream2 (~1.9B params, Apache-2.0) — chosen for fast
single-image VQA on modest/CPU-capable hardware. Swappable via VLM_MODEL_ID /
VLM_MODEL_REVISION without touching this file's logic.

Run: python vlm_quality_service.py
Env: VLM_QUALITY_PORT (default 5065), VLM_MODEL_ID, VLM_MODEL_REVISION,
     VLM_DEVICE (cpu|cuda, default cpu)
"""

import os, io, logging, time
from pathlib import Path
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from PIL import Image

# Load backend/api/.env (one directory up from this script) so VLM_MODEL_ID
# etc. live alongside the Node backend's own config instead of needing to be
# re-exported as shell env vars every time this script is launched. Real
# process env vars (if already set) still take precedence — override=False.
load_dotenv(Path(__file__).resolve().parent.parent / '.env', override=False)

logging.basicConfig(level=logging.INFO,
                    format='[vlm-quality] %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

MODEL_ID = os.environ.get('VLM_MODEL_ID', 'vikhyatk/moondream2')
MODEL_REVISION = os.environ.get('VLM_MODEL_REVISION', '2024-08-26')
DEVICE = os.environ.get('VLM_DEVICE', 'cpu').strip().lower()

PROMPT = (
    "Does this image show one clear, unobstructed human face suitable for an "
    "ID photo? Answer with a single word, yes or no, then a short reason."
)

# ── Load the VLM once at startup ───────────────────────────────────────────────
model = None
tokenizer = None

def load_model(model_id: str = MODEL_ID, revision: str = MODEL_REVISION):
    """Adapter around model loading — kept as one function so swapping to a
    different VLM later (e.g. a larger GPU-hosted model) only touches this
    function, not the request-handling code below."""
    global model, tokenizer
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        log.info(f"Loading VLM {model_id}@{revision} on {DEVICE} …")
        loaded_model = AutoModelForCausalLM.from_pretrained(
            model_id, trust_remote_code=True, revision=revision
        )
        if DEVICE == 'cuda' and torch.cuda.is_available():
            loaded_model = loaded_model.to('cuda')
        loaded_tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)
        model, tokenizer = loaded_model, loaded_tokenizer
        log.info("✅ VLM ready")
    except Exception as e:
        log.error(f"❌ VLM load failed: {e}")
        model, tokenizer = None, None

load_model()

# ── Answer parsing ──────────────────────────────────────────────────────────────

REASON_KEYWORDS = {
    'blurry': 'blurry',
    'blur': 'blurry',
    'out of focus': 'blurry',
    'no face': 'no_face',
    'no human face': 'no_face',
    'not show a face': 'no_face',
    'no person': 'no_face',
    'occlud': 'occluded',
    'obscur': 'occluded',
    'covered': 'occluded',
    'hand': 'occluded',
    'mask': 'occluded',
    'multiple face': 'multiple_faces',
    'more than one face': 'multiple_faces',
    'several face': 'multiple_faces',
    'crop': 'bad_crop',
    'cut off': 'bad_crop',
    'partial': 'bad_crop',
    'side': 'bad_crop',
    'angle': 'bad_crop',
    'clear': 'clear_frontal_face',
    'well-lit': 'clear_frontal_face',
    'frontal': 'clear_frontal_face',
}

def parse_answer(raw_answer: str):
    text = (raw_answer or '').strip()
    lower = text.lower()
    usable = lower.startswith('yes')

    reason = 'other'
    for keyword, mapped in REASON_KEYWORDS.items():
        if keyword in lower:
            reason = mapped
            break
    if reason == 'other' and usable:
        reason = 'clear_frontal_face'

    return usable, reason


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "model_loaded": model is not None,
        "model_id": MODEL_ID,
    })


@app.route('/check-frame', methods=['POST'])
def check_frame():
    t0 = time.time()

    if 'image' not in request.files:
        return jsonify({"error": "No image file in request"}), 400

    file_bytes = request.files['image'].read()
    try:
        img = Image.open(io.BytesIO(file_bytes)).convert('RGB')
    except Exception as e:
        log.warning(f"Could not decode image: {e}")
        return jsonify({"error": "Could not decode image"}), 400

    if model is None or tokenizer is None:
        return jsonify({"error": "model_unavailable"}), 503

    try:
        enc_image = model.encode_image(img)
        raw_answer = model.answer_question(enc_image, PROMPT, tokenizer)
    except Exception as e:
        log.error(f"VLM inference failed: {e}")
        return jsonify({"error": "inference_failed"}), 503

    usable, reason = parse_answer(raw_answer)

    return jsonify({
        "usable": usable,
        "reason": reason,
        "raw_answer": raw_answer,
        "model_id": MODEL_ID,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    })


if __name__ == '__main__':
    port = int(os.environ.get('VLM_QUALITY_PORT', 5065))
    log.info(f"Starting VLM quality service on port {port}")
    app.run(host='127.0.0.1', port=port, threaded=True)
