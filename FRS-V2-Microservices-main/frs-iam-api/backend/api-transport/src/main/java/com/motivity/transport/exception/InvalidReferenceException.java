package com.motivity.transport.exception;

/** A referenced id (routeId, busId, ...) doesn't resolve under the caller's own tenant — same principle as NotFoundException, applied to a foreign-key-shaped input field instead of the path id. */
public class InvalidReferenceException extends RuntimeException {
    public InvalidReferenceException(String message) {
        super(message);
    }
}
