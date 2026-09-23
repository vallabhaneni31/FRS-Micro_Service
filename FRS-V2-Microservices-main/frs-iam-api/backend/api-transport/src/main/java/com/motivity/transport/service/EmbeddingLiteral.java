package com.motivity.transport.service;

/** pgvector's text input format: "[0.1,0.2,...]" — shared by insert and match queries. */
final class EmbeddingLiteral {
    private EmbeddingLiteral() {}

    static String of(float[] embedding) {
        StringBuilder sb = new StringBuilder(embedding.length * 8);
        sb.append('[');
        for (int i = 0; i < embedding.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(embedding[i]);
        }
        sb.append(']');
        return sb.toString();
    }
}
