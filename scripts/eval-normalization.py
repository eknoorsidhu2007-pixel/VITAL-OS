#!/usr/bin/env python3
"""Evaluate ASR error correction: Precision@1, Recall@3, MRR."""

import json
import sys
from pathlib import Path

try:
    from sentence_transformers import SentenceTransformer, util
except ImportError:
    print("pip install sentence-transformers torch")
    sys.exit(1)

VOCAB_PATH = Path("data/medical-vocabulary-with-embeddings.json")
TEST_PATH = Path("data/asr-test-pairs.json")

def main():
    if not VOCAB_PATH.exists() or not TEST_PATH.exists():
        print("Run train-normalization.py and create asr-test-pairs.json first")
        sys.exit(1)

    model = SentenceTransformer("all-MiniLM-L6-v2")
    with open(VOCAB_PATH) as f:
        vocab = json.load(f)
    with open(TEST_PATH) as f:
        tests = json.load(f)

    embeddings = [e["embedding"] for e in vocab]
    terms = [e["term"] for e in vocab]

    p1 = r3 = mrr = 0
    for pair in tests:
        raw, expected = pair["raw"], pair["expected"].lower()
        raw_emb = model.encode(raw)
        scores = [util.cos_sim(raw_emb, e).item() for e in embeddings]
        ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
        rank = next((i + 1 for i, (idx, _) in enumerate(ranked) if terms[idx].lower() == expected), None)
        if rank == 1:
            p1 += 1
        if rank and rank <= 3:
            r3 += 1
        if rank:
            mrr += 1.0 / rank

    n = len(tests)
    print(f"Precision@1: {p1 / n:.3f}")
    print(f"Recall@3:    {r3 / n:.3f}")
    print(f"MRR:         {mrr / n:.3f}")

if __name__ == "__main__":
    main()