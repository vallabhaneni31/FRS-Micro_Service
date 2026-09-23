package com.motivity.transport.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/**
 * Used for both create and update (PATCH semantics on update: a null field
 * leaves the existing value alone — see PassengerService.update). busId,
 * passengerCode, and fullName are required on create; the service enforces
 * that separately since a single DTO is shared between the two operations.
 */
public record PassengerRequest(
        UUID busId,
        @Size(max = 50) String passengerCode,
        @Size(max = 200) String fullName,
        @Size(max = 20) String phone,
        @Email @Size(max = 200) String email,
        @Size(max = 200) String boardingStop,
        @Size(max = 200) String deboardingStop,
        @Pattern(regexp = "active|inactive") String status
) {
}
