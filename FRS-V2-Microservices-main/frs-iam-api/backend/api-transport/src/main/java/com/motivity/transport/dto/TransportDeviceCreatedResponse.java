package com.motivity.transport.dto;

/** Returned ONLY from device creation and secret rotation — the one and only time the plaintext secret is ever exposed. */
public record TransportDeviceCreatedResponse(TransportDeviceResponse device, String deviceSecret) {
}
