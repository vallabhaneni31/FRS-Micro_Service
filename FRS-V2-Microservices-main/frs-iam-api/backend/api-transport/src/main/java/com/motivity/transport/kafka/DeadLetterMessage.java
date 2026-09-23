package com.motivity.transport.kafka;

import java.time.Instant;

public record DeadLetterMessage(
        String originalTopic,
        String errorMessage,
        Instant failedAt,
        TransportDeviceEventMessage originalMessage
) {
}
