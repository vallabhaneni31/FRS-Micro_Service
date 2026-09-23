package com.motivity.transport;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration;

// UserDetailsServiceAutoConfiguration excluded: this service never
// authenticates via Spring's UserDetailsService/AuthenticationManager path
// (DeviceAuthFilter and KeycloakAuthFilter both populate the
// SecurityContext directly), so without this exclusion Spring Boot
// generates an unused in-memory "user" with a random password on every
// boot — dead code and a stray credential nothing should ever reach for,
// not a real gap, but worth removing rather than leaving unexplained.
@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
public class TransportApplication {
    public static void main(String[] args) {
        SpringApplication.run(TransportApplication.class, args);
    }
}
