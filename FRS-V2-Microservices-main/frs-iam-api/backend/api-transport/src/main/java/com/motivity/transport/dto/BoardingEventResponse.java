package com.motivity.transport.dto;

import com.motivity.transport.entity.BoardingEvent;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

public record BoardingEventResponse(
        UUID id,
        UUID busId,
        UUID deviceId,
        String eventType,
        String personRef,
        UUID passengerId,
        BigDecimal confidence,
        String photoKey,
        OffsetDateTime eventTime,
        OffsetDateTime receivedAt
) {
    public static BoardingEventResponse from(BoardingEvent event) {
        return new BoardingEventResponse(
                event.getId(), event.getBusId(), event.getDeviceId(), event.getEventType(),
                event.getPersonRef(), event.getPassengerId(), event.getConfidence(), event.getPhotoKey(),
                event.getEventTime(), event.getReceivedAt());
    }
}
