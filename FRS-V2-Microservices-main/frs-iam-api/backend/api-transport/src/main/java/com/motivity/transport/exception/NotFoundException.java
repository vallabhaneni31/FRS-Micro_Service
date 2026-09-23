package com.motivity.transport.exception;

/** A resource wasn't found for the caller's own tenant — deliberately the same response whether it doesn't exist at all or belongs to a different tenant, so no cross-tenant existence is ever leaked. */
public class NotFoundException extends RuntimeException {
    public NotFoundException(String message) {
        super(message);
    }
}
