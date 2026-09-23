package com.motivity.transport.controller;

import com.motivity.transport.dto.EmbeddingSummaryResponse;
import com.motivity.transport.security.TransportAuthorization;
import com.motivity.transport.service.EnrollmentService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;
import java.util.UUID;

import static com.motivity.transport.security.TransportPermission.*;

/** Human/Keycloak-authenticated only — falls under SecurityConfig's userChain, never the device chain. */
@RestController
@RequestMapping("/api/transport/passengers/{passengerId}/photos")
public class EnrollmentController {

    private final EnrollmentService enrollmentService;

    public EnrollmentController(EnrollmentService enrollmentService) {
        this.enrollmentService = enrollmentService;
    }

    @PostMapping(consumes = "multipart/form-data")
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_WRITE + "')")
    public ResponseEntity<Void> enroll(@PathVariable UUID passengerId,
                                        @RequestParam("photo") MultipartFile photo,
                                        @RequestParam("angle") String angle,
                                        Authentication authentication) throws IOException {
        enrollmentService.enrollPhoto(TransportAuthorization.scopeOf(authentication), passengerId, photo.getBytes(), angle);
        return ResponseEntity.status(HttpStatus.CREATED).build();
    }

    @GetMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_READ + "')")
    public List<EmbeddingSummaryResponse> list(@PathVariable UUID passengerId, Authentication authentication) {
        return enrollmentService.listEmbeddings(TransportAuthorization.scopeOf(authentication), passengerId)
                .stream().map(EmbeddingSummaryResponse::from).toList();
    }

    @DeleteMapping
    @PreAuthorize("@transportAuthz.has(authentication, '" + PASSENGERS_WRITE + "')")
    public ResponseEntity<Void> reset(@PathVariable UUID passengerId, Authentication authentication) {
        enrollmentService.resetEnrollment(TransportAuthorization.scopeOf(authentication), passengerId);
        return ResponseEntity.noContent().build();
    }
}
