package com.motivity.transport.controller;

import com.motivity.transport.dto.OccupancyResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.OccupancyService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.OCCUPANCY_READ;

@RestController
@RequestMapping("/api/transport/occupancy")
public class OccupancyController {

    private final OccupancyService occupancyService;

    public OccupancyController(OccupancyService occupancyService) {
        this.occupancyService = occupancyService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + OCCUPANCY_READ + "')")
    public List<OccupancyResponse> list(Authentication authentication) {
        return occupancyService.list(TransportAuthorization.scopeOf(authentication));
    }

    @GetMapping("/{busId}")
    @PreAuthorize("@transportAuthz.has(authentication, '" + OCCUPANCY_READ + "')")
    public OccupancyResponse get(@PathVariable UUID busId, Authentication authentication) {
        return occupancyService.get(TransportAuthorization.scopeOf(authentication), busId);
    }
}
