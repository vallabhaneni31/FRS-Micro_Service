package com.motivity.transport.controller;

import com.motivity.transport.dto.BoardingEventResponse;
import com.motivity.transport.dto.PagedResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.BoardingEventHistoryService;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.EVENTS_READ;

@RestController
@RequestMapping("/api/transport/events")
public class EventHistoryController {

    // Bounded the same way the device-side batch endpoint bounds itself
    // (phase 2d) — a caller cannot force an unbounded scan/response.
    private static final int MAX_PAGE_SIZE = 200;
    private static final int DEFAULT_PAGE_SIZE = 20;

    private final BoardingEventHistoryService historyService;

    public EventHistoryController(BoardingEventHistoryService historyService) {
        this.historyService = historyService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + EVENTS_READ + "')")
    public PagedResponse<BoardingEventResponse> search(
            @RequestParam(required = false) UUID busId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime to,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "" + DEFAULT_PAGE_SIZE) int size,
            Authentication authentication) {
        int boundedSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        return historyService.search(TransportAuthorization.scopeOf(authentication), busId, from, to, page, boundedSize);
    }
}
