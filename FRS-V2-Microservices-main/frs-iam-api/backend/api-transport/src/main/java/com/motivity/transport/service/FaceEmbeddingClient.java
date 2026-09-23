package com.motivity.transport.service;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

import java.time.Duration;

/**
 * Calls the dedicated Transport face-quality-svc instance (port 5051 by
 * default) — a SEPARATE deployment from corporate's :5050 instance, same
 * script, zero shared process (see the plan's "face-quality-svc
 * reuse-safety" note on why sharing the live corporate instance was
 * rejected). A short timeout since this sits in the boarding-event hot
 * path indirectly (PassengerMatchingService) and must fail fast rather
 * than hold things up.
 *
 * A "no face found" or bad-quality result is a normal 200 response with
 * face_detected: false — that's returned as a structured result, not an
 * exception. An actual failure (service down, timeout, malformed request)
 * throws, same as any other RestClient call — callers decide how to react
 * (EnrollmentService surfaces it to the admin as a real error;
 * PassengerMatchingService catches and degrades to "unmatched").
 */
@Component
public class FaceEmbeddingClient {

    private static final Duration TIMEOUT = Duration.ofSeconds(5);

    private final RestClient restClient;

    public FaceEmbeddingClient(@Value("${transport.face-quality.url:http://127.0.0.1:5051}") String baseUrl) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) TIMEOUT.toMillis());
        factory.setReadTimeout((int) TIMEOUT.toMillis());
        this.restClient = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(factory)
                .build();
    }

    public FaceEmbeddingResult embed(byte[] photoBytes, String angle) {
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("image", new ByteArrayResource(photoBytes) {
            @Override
            public String getFilename() {
                return "photo.jpg";
            }
        });
        if (angle != null) {
            body.add("angle", angle);
        }

        JsonNode json = restClient.post()
                .uri("/quality")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(body)
                .retrieve()
                .body(JsonNode.class);

        boolean faceDetected = json != null && json.path("face_detected").asBoolean(false);
        double confidence = json != null ? json.path("confidence").asDouble(0.0) : 0.0;
        String modelVersion = (json != null && json.hasNonNull("model_version")) ? json.get("model_version").asText() : null;

        float[] embedding = null;
        if (json != null && json.hasNonNull("embedding") && json.get("embedding").isArray()) {
            JsonNode arr = json.get("embedding");
            embedding = new float[arr.size()];
            for (int i = 0; i < arr.size(); i++) {
                embedding[i] = (float) arr.get(i).asDouble();
            }
        }

        return new FaceEmbeddingResult(embedding, confidence, faceDetected, modelVersion);
    }

    public record FaceEmbeddingResult(float[] embedding, double confidence, boolean faceDetected, String modelVersion) {
        public boolean hasEmbedding() {
            return embedding != null && embedding.length > 0;
        }
    }
}
