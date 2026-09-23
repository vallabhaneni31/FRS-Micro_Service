package com.motivity.transport.dto;

import java.util.List;

public record DeviceEventBatchResponse(boolean success, int processed, List<BatchEventResult> results) {
}
