package com.motivity.transport.dto;

import com.motivity.transport.entity.Passenger;

import java.time.OffsetDateTime;
import java.util.UUID;

public record PassengerResponse(
        UUID id,
        UUID busId,
        String passengerCode,
        String fullName,
        String phone,
        String email,
        String boardingStop,
        String deboardingStop,
        String status,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
) {
    public static PassengerResponse from(Passenger passenger) {
        return new PassengerResponse(
                passenger.getId(), passenger.getBusId(), passenger.getPassengerCode(), passenger.getFullName(),
                passenger.getPhone(), passenger.getEmail(), passenger.getBoardingStop(), passenger.getDeboardingStop(),
                passenger.getStatus(), passenger.getCreatedAt(), passenger.getUpdatedAt());
    }
}
