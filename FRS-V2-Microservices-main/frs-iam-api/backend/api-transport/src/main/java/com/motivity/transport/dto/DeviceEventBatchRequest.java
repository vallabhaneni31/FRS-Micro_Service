package com.motivity.transport.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;

import java.util.List;

/**
 * Upper bound (100 events) is deliberately NOT a @Size constraint here —
 * exceeding it should return 413 Payload Too Large with a specific body
 * (matching the documented device API contract and the existing platform's
 * batch endpoint), not a generic 400 validation error. See
 * DeviceEventController.MAX_BATCH_EVENTS.
 */
public record DeviceEventBatchRequest(
        @NotEmpty @Valid List<DeviceEventRequest> events
) {
}
