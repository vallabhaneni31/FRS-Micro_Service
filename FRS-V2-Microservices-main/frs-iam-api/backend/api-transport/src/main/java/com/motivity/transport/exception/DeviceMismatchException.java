package com.motivity.transport.exception;

/** The deviceId in the URL doesn't match the authenticated device's own id — mirrors the documented DEVICE_MISMATCH error. */
public class DeviceMismatchException extends RuntimeException {
    public DeviceMismatchException() {
        super("device id in URL does not match the authenticated device");
    }
}
