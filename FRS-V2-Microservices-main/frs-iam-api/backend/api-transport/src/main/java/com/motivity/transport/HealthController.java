package com.motivity.transport;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

/**
 * Matches backend/api's GET /api/health shape (status + timestamp) so
 * existing monitoring conventions extend to this service without a new
 * pattern. DB/Kafka dependency checks are added in later phases once those
 * layers exist — this one only proves the process is up.
 */
@RestController
public class HealthController {

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "ok",
            "service", "api-transport",
            "timestamp", Instant.now().toString()
        );
    }
}
