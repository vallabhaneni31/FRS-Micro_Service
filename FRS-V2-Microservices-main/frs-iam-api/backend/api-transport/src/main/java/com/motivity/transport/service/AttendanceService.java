package com.motivity.transport.service;

import com.motivity.transport.dto.AttendanceRecordResponse;
import com.motivity.transport.entity.BoardingEvent;
import com.motivity.transport.entity.Passenger;
import com.motivity.transport.exception.InvalidReferenceException;
import com.motivity.transport.repository.BoardingEventRepository;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.PassengerRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Derived, read-only — no attendance table of its own. One row per enrolled
 * passenger in scope, status derived from that day's boarding_events
 * (already resolved to passenger_id by Phase 5's matching pipeline).
 */
@Service
public class AttendanceService {

    private final PassengerRepository passengerRepository;
    private final BoardingEventRepository boardingEventRepository;
    private final BusRepository busRepository;

    public AttendanceService(PassengerRepository passengerRepository, BoardingEventRepository boardingEventRepository,
                              BusRepository busRepository) {
        this.passengerRepository = passengerRepository;
        this.boardingEventRepository = boardingEventRepository;
        this.busRepository = busRepository;
    }

    public List<AttendanceRecordResponse> getDailyAttendance(TransportScope scope, LocalDate date, UUID requestedBusId) {
        if (requestedBusId != null) {
            requireBusIdInScope(scope, requestedBusId);
        }

        List<Passenger> passengers = requestedBusId != null
                ? passengerRepository.findAllByTenantIdAndBusId(scope.tenantId(), requestedBusId)
                : switch (scope.level()) {
                    case TENANT_WIDE -> passengerRepository.findAllByTenantId(scope.tenantId());
                    case DEPOT -> passengerRepository.findAllByTenantIdAndBusDepotId(scope.tenantId(), scope.depotId());
                    case BUS -> passengerRepository.findAllByTenantIdAndBusId(scope.tenantId(), scope.busId());
                    case UNASSIGNED -> List.<Passenger>of();
                };

        if (passengers.isEmpty()) {
            return List.of();
        }

        OffsetDateTime from = date.atStartOfDay(ZoneOffset.UTC).toOffsetDateTime();
        OffsetDateTime to = from.plusDays(1);
        UUID searchBusId = requestedBusId != null ? requestedBusId
                : (scope.level() == TransportScope.Level.BUS ? scope.busId() : null);
        UUID searchDepotId = (requestedBusId == null && scope.level() == TransportScope.Level.DEPOT) ? scope.depotId() : null;

        List<BoardingEvent> events = boardingEventRepository
                .search(scope.tenantId(), searchBusId, searchDepotId, from, to, Pageable.unpaged())
                .stream()
                .filter(e -> e.getPassengerId() != null)
                .sorted(Comparator.comparing(BoardingEvent::getEventTime))
                .toList();

        Map<UUID, List<BoardingEvent>> byPassenger = new HashMap<>();
        for (BoardingEvent e : events) {
            byPassenger.computeIfAbsent(e.getPassengerId(), k -> new ArrayList<>()).add(e);
        }

        return passengers.stream().map(passenger -> {
            List<BoardingEvent> passengerEvents = byPassenger.getOrDefault(passenger.getId(), List.of());
            String status;
            if (passengerEvents.isEmpty()) {
                status = "not_boarded";
            } else {
                BoardingEvent last = passengerEvents.get(passengerEvents.size() - 1);
                status = "DEBOARDING".equals(last.getEventType()) ? "boarded" : "boarded_no_deboard";
            }
            return new AttendanceRecordResponse(passenger.getId(), passenger.getPassengerCode(), passenger.getFullName(), status);
        }).toList();
    }

    private void requireBusIdInScope(TransportScope scope, UUID busId) {
        boolean inScope = switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> busRepository.findByIdAndTenantId(busId, scope.tenantId())
                    .map(b -> scope.depotId().equals(b.getDepotId())).orElse(false);
            case BUS -> scope.busId().equals(busId);
            case UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new InvalidReferenceException("busId does not belong to your scope: " + busId);
        }
    }
}
