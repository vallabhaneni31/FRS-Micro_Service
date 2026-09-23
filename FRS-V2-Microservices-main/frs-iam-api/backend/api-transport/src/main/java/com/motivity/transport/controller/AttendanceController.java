package com.motivity.transport.controller;

import com.motivity.transport.dto.AttendanceRecordResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.AttendanceService;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.REPORTS_READ;

/** Human/Keycloak-authenticated only — falls under SecurityConfig's userChain, never the device chain. */
@RestController
@RequestMapping("/api/transport/attendance")
public class AttendanceController {

    private final AttendanceService attendanceService;

    public AttendanceController(AttendanceService attendanceService) {
        this.attendanceService = attendanceService;
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + REPORTS_READ + "')")
    public List<AttendanceRecordResponse> getDailyAttendance(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date,
            @RequestParam(required = false) UUID busId,
            Authentication authentication) {
        return attendanceService.getDailyAttendance(TransportAuthorization.scopeOf(authentication), date, busId);
    }
}
