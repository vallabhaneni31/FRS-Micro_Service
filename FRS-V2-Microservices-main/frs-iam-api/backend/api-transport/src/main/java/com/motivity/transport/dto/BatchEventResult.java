package com.motivity.transport.dto;

import java.util.UUID;

public record BatchEventResult(int index, UUID eventId, String status, String message) {
}
