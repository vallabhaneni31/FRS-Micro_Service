package com.motivity.transport.service;

import com.motivity.transport.dto.BoardingEventResponse;
import com.motivity.transport.dto.PagedResponse;
import com.motivity.transport.repository.BoardingEventRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.UUID;

@Service
public class BoardingEventHistoryService {

    private final BoardingEventRepository boardingEventRepository;

    public BoardingEventHistoryService(BoardingEventRepository boardingEventRepository) {
        this.boardingEventRepository = boardingEventRepository;
    }

    /**
     * BUS scope forces busId to the caller's own bus regardless of what was
     * requested (same "never trust client input for the boundary that
     * matters" rule as BusService) — an Operations Manager cannot page
     * through another bus's history by simply changing the busId query
     * param. DEPOT scope forces depotId; the repository query intersects
     * it with any caller-supplied busId, so a Route Manager requesting a
     * bus outside their depot gets zero rows, not another depot's data.
     * UNASSIGNED never reaches the database at all.
     */
    public PagedResponse<BoardingEventResponse> search(TransportScope scope, UUID requestedBusId,
                                                         OffsetDateTime from, OffsetDateTime to, int page, int size) {
        var pageable = PageRequest.of(page, size);

        if (scope.level() == TransportScope.Level.UNASSIGNED) {
            return PagedResponse.from(Page.empty(pageable), BoardingEventResponse::from);
        }

        UUID busId = scope.level() == TransportScope.Level.BUS ? scope.busId() : requestedBusId;
        UUID depotId = scope.level() == TransportScope.Level.DEPOT ? scope.depotId() : null;

        // Deliberately unsorted Pageable: for a NATIVE query, Spring Data
        // appends a Sort's property names to the SQL as-is, with no
        // entity->column translation (that only happens for JPQL/derived
        // queries) — a Sort by the entity field "eventTime" broke with
        // "column eventtime does not exist" once the query became native
        // (fixing the two earlier issues in this same query surfaced this
        // one). The repository query's own explicit ORDER BY event_time
        // DESC is the only sort here.
        var result = boardingEventRepository.search(scope.tenantId(), busId, depotId, from, to, pageable);
        return PagedResponse.from(result, BoardingEventResponse::from);
    }
}
