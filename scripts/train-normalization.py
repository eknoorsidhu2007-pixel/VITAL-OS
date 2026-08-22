#!/usr/bin/env python3
"""Generate embeddings for medical vocabulary using all-MiniLM-L6-v2."""

import json
import sys
from pathlib import Path

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print("pip install sentence-transformers")
    sys.exit(1)

VOCAB_IN = Path("data/medical-vocabulary.json")
VOCAB_OUT = Path("data/medical-vocabulary-with-embeddings.json")

def main():
    if not VOCAB_IN.exists():
        print(f"Create {VOCAB_IN} first")
        sys.exit(1)

    model = SentenceTransformer("all-MiniLM-L6-v2")
    with open(VOCAB_IN) as f:
        vocab = json.load(f)

    terms = [e["term"] for e in vocab]
    embeddings = model.encode(terms, show_progress_bar=True)

    for e, emb in zip(vocab, embeddings):
        e["embedding"] = emb.tolist()

    with open(VOCAB_OUT, "w") as f:
        json.dump(vocab, f, indent=2)
    print(f"Wrote {VOCAB_OUT}")

if __name__ == "__main__":
    main()