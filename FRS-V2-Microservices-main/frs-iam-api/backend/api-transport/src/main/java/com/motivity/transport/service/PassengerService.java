package com.motivity.transport.service;

import com.motivity.transport.dto.PassengerRequest;
import com.motivity.transport.dto.PassengerResponse;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.Passenger;
import com.motivity.transport.exception.InvalidReferenceException;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.PassengerRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Mirrors BusService/TransportDeviceService's scope-checking pattern.
 * Passengers have no depot_id of their own — depot scoping goes through the
 * owning bus's depot_id, same as TransportDevice.
 */
@Service
public class PassengerService {

    private final PassengerRepository passengerRepository;
    private final BusRepository busRepository;

    public PassengerService(PassengerRepository passengerRepository, BusRepository busRepository) {
        this.passengerRepository = passengerRepository;
        this.busRepository = busRepository;
    }

    public List<PassengerResponse> list(TransportScope scope) {
        List<Passenger> passengers = switch (scope.level()) {
            case TENANT_WIDE -> passengerRepository.findAllByTenantId(scope.tenantId());
            case DEPOT -> passengerRepository.findAllByTenantIdAndBusDepotId(scope.tenantId(), scope.depotId());
            case BUS -> passengerRepository.findAllByTenantIdAndBusId(scope.tenantId(), scope.busId());
            case UNASSIGNED -> List.of();
        };
        return passengers.stream().map(PassengerResponse::from).toList();
    }

    public PassengerResponse get(TransportScope scope, UUID id) {
        return PassengerResponse.from(requireInScope(scope, id));
    }

    @Transactional
    public PassengerResponse create(TransportScope scope, PassengerRequest request) {
        if (request.busId() == null) {
            throw new IllegalArgumentException("busId is required");
        }
        if (request.passengerCode() == null || request.passengerCode().isBlank()) {
            throw new IllegalArgumentException("passengerCode is required");
        }
        if (request.fullName() == null || request.fullName().isBlank()) {
            throw new IllegalArgumentException("fullName is required");
        }
        requireBusInScope(scope, request.busId());

        Passenger passenger = Passenger.builder()
                .tenantId(scope.tenantId())
                .busId(request.busId())
                .passengerCode(request.passengerCode())
                .fullName(request.fullName())
                .phone(request.phone())
                .email(request.email())
                .boardingStop(request.boardingStop())
                .deboardingStop(request.deboardingStop())
                .status(request.status() != null ? request.status() : "active")
                .build();
        return PassengerResponse.from(passengerRepository.save(passenger));
    }

    // PATCH semantics: only non-null fields in the request overwrite the existing row.
    @Transactional
    public PassengerResponse update(TransportScope scope, UUID id, PassengerRequest request) {
        Passenger passenger = requireInScope(scope, id);

        if (request.busId() != null) {
            requireBusInScope(scope, request.busId());
            passenger.setBusId(request.busId());
        }
        if (request.passengerCode() != null) passenger.setPassengerCode(request.passengerCode());
        if (request.fullName() != null) passenger.setFullName(request.fullName());
        if (request.phone() != null) passenger.setPhone(request.phone());
        if (request.email() != null) passenger.setEmail(request.email());
        if (request.boardingStop() != null) passenger.setBoardingStop(request.boardingStop());
        if (request.deboardingStop() != null) passenger.setDeboardingStop(request.deboardingStop());
        if (request.status() != null) passenger.setStatus(request.status());

        return PassengerResponse.from(passengerRepository.save(passenger));
    }

    @Transactional
    public void delete(TransportScope scope, UUID id) {
        Passenger passenger = requireInScope(scope, id);
        passengerRepository.delete(passenger);
    }

    /**
     * Fetches by tenant+id, then additionally enforces the caller's
     * depot/bus scope. A passenger outside the caller's scope resolves to
     * NotFoundException, same as a different tenant's passenger — never
     * leaks existence.
     */
    Passenger requireInScope(TransportScope scope, UUID id) {
        Passenger passenger = passengerRepository.findByIdAndTenantId(id, scope.tenantId())
                .orElseThrow(() -> new NotFoundException("passenger not found: " + id));
        if (!busInScope(scope, passenger.getBusId())) {
            throw new NotFoundException("passenger not found: " + id);
        }
        return passenger;
    }

    // buses.id has no tenant-aware foreign key at the database level — a
    // passenger must never be linkable to another tenant's bus. For a
    // DEPOT-scoped caller, the bus must additionally belong to their own
    // depot — a Route Manager cannot enroll a passenger against a bus
    // outside their scope even if they somehow knew its id.
    private void requireBusInScope(TransportScope scope, UUID busId) {
        Bus bus = busRepository.findByIdAndTenantId(busId, scope.tenantId())
                .orElseThrow(() -> new InvalidReferenceException("busId does not belong to your tenant: " + busId));
        boolean inScope = switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> scope.depotId().equals(bus.getDepotId());
            case BUS -> scope.busId().equals(bus.getId());
            case UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new InvalidReferenceException("busId does not belong to your scope: " + busId);
        }
    }

    private boolean busInScope(TransportScope scope, UUID busId) {
        return switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> busRepository.findByIdAndTenantId(busId, scope.tenantId())
                    .map(b -> scope.depotId().equals(b.getDepotId())).orElse(false);
            case BUS -> scope.busId().equals(busId);
            case UNASSIGNED -> false;
        };
    }
}
