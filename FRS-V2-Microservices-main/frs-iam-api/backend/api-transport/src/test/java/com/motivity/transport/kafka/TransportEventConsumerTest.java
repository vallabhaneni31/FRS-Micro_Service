package com.motivity.transport.kafka;

import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.Passenger;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.repository.BoardingEventRepository;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.OccupancySnapshotRepository;
import com.motivity.transport.repository.PassengerRepository;
import com.motivity.transport.repository.TransportDeviceRepository;
import com.motivity.transport.security.TransportScope;
import com.motivity.transport.service.EnrollmentService;
import com.motivity.transport.service.TransportStorageService;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.domain.Pageable;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Properties;
import java.util.UUID;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Phase 2e verification. The whole app — including the real @KafkaListener
 * — runs in this Spring context, so publishing a message here exercises
 * the true end-to-end path: Kafka -> TransportEventConsumer -> claim ->
 * boarding_events insert -> occupancy upsert, or -> dead-letter, exactly as
 * it runs in production. Assertions poll with a generous timeout rather
 * than sleeping a fixed amount — consumption is asynchronous relative to
 * the test thread, and whichever test runs first in this class also pays
 * the listener container's one-time group-join/rebalance cost (observed
 * ~6-9s cold), not just message processing time.
 */
@SpringBootTest
class TransportEventConsumerTest {

    private static final int TIMEOUT_SECONDS = 25;

    @Autowired
    private TransportEventProducer producer;

    @Autowired
    private BusRepository busRepository;

    @Autowired
    private TransportDeviceRepository deviceRepository;

    @Autowired
    private BoardingEventRepository boardingEventRepository;

    @Autowired
    private OccupancySnapshotRepository occupancySnapshotRepository;

    @Autowired
    private PassengerRepository passengerRepository;

    @Autowired
    private EnrollmentService enrollmentService;

    @Autowired
    private TransportStorageService storageService;

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Value("${transport.kafka.topic-prefix}")
    private String topicPrefix;

    @Test
    void boardingIncrementsOccupancyFromZero() {
        UUID tenantId = UUID.randomUUID();
        TestFixture fx = persistBusAndDevice(tenantId);

        producer.publish(boardingEvent(tenantId, fx.bus.getId(), fx.device.getId(), "BOARDING"));

        awaitUntil(() -> Objects.equals(occupancyOf(fx.bus.getId()), 1), TIMEOUT_SECONDS);
        assertThat(boardingEventRepository.findAllByTenantId(tenantId, Pageable.unpaged()).getTotalElements()).isEqualTo(1);
    }

    @Test
    void boardingThenDeboardingNetsToZero() {
        UUID tenantId = UUID.randomUUID();
        TestFixture fx = persistBusAndDevice(tenantId);

        producer.publish(boardingEvent(tenantId, fx.bus.getId(), fx.device.getId(), "BOARDING"));
        awaitUntil(() -> Objects.equals(occupancyOf(fx.bus.getId()), 1), TIMEOUT_SECONDS);

        producer.publish(boardingEvent(tenantId, fx.bus.getId(), fx.device.getId(), "DEBOARDING"));
        awaitUntil(() -> Objects.equals(occupancyOf(fx.bus.getId()), 0), TIMEOUT_SECONDS);
    }

    @Test
    void aDeboardingAsTheVeryFirstEventForABusFloorsAtZeroInsteadOfGoingNegative() {
        UUID tenantId = UUID.randomUUID();
        TestFixture fx = persistBusAndDevice(tenantId);

        producer.publish(boardingEvent(tenantId, fx.bus.getId(), fx.device.getId(), "DEBOARDING"));

        awaitUntil(() -> occupancyOf(fx.bus.getId()) != null, TIMEOUT_SECONDS);
        assertThat(occupancyOf(fx.bus.getId())).isEqualTo(0); // not -1
    }

    @Test
    void redeliveringTheSameEventUidDoesNotDoubleProcess() {
        UUID tenantId = UUID.randomUUID();
        TestFixture fx = persistBusAndDevice(tenantId);

        TransportDeviceEventMessage message = boardingEvent(tenantId, fx.bus.getId(), fx.device.getId(), "BOARDING");
        producer.publish(message);
        awaitUntil(() -> Objects.equals(occupancyOf(fx.bus.getId()), 1), TIMEOUT_SECONDS);

        // Same eventUid, published again — simulates a Kafka at-least-once redelivery.
        producer.publish(message);
        sleepQuietly(3000); // give the (incorrect, if buggy) duplicate a chance to land

        assertThat(occupancyOf(fx.bus.getId())).isEqualTo(1); // still 1, not 2
        long rows = boardingEventRepository.findAllByTenantId(tenantId, Pageable.unpaged()).getTotalElements();
        assertThat(rows).isEqualTo(1);
    }

    @Test
    void aBogusBusReferenceEndsUpOnTheDeadLetterTopicAfterRetriesExhaustAndDoesNotBlockTheNextEvent() {
        UUID tenantId = UUID.randomUUID();
        UUID nonExistentBusId = UUID.randomUUID(); // no row in buses — violates the FK on boarding_events
        UUID nonExistentDeviceId = UUID.randomUUID();
        TransportDeviceEventMessage badMessage = boardingEvent(tenantId, nonExistentBusId, nonExistentDeviceId, "BOARDING");

        // A real, good event right after — proves one bad event doesn't block the rest.
        TestFixture fx = persistBusAndDevice(tenantId);
        TransportDeviceEventMessage goodMessage = boardingEvent(tenantId, fx.bus.getId(), fx.device.getId(), "BOARDING");

        producer.publish(badMessage);
        producer.publish(goodMessage);

        ConsumerRecord<String, String> deadLettered = consumeDeadLetterUntilFound(badMessage.eventUid().toString(), TIMEOUT_SECONDS);
        assertThat(deadLettered).isNotNull();
        assertThat(deadLettered.value()).contains(nonExistentBusId.toString());

        awaitUntil(() -> Objects.equals(occupancyOf(fx.bus.getId()), 1), TIMEOUT_SECONDS);
    }

    // ---- Track B, Phase 5: passenger matching wired into this same real pipeline ----

    @Test
    void aBoardingEventWithAPhotoKeyResolvesToTheEnrolledPassenger() throws Exception {
        UUID tenantId = UUID.randomUUID();
        TestFixture fx = persistBusAndDevice(tenantId);

        Passenger passenger = passengerRepository.save(Passenger.builder()
                .tenantId(tenantId).busId(fx.bus.getId())
                .passengerCode("MATCH-" + UUID.randomUUID().toString().substring(0, 8))
                .fullName("Match Test Passenger").status("active").build());

        byte[] photo = Files.readAllBytes(Path.of(getClass().getClassLoader().getResource("test-face-front.jpg").toURI()));
        enrollmentService.enrollPhoto(TransportScope.tenantWide(tenantId), passenger.getId(), photo, "front");

        // Same photo bytes a device would have PUT to the /photos endpoint
        // for this boarding event — stored directly via the storage service
        // here since the HTTP upload path itself is covered elsewhere
        // (device-auth gating only, no real face content needed there).
        String photoKey = TransportStorageService.eventPhotoKey(tenantId, fx.bus.getId());
        storageService.store(photoKey, photo, "image/jpeg");

        TransportDeviceEventMessage message = new TransportDeviceEventMessage(
                UUID.randomUUID(), tenantId, fx.bus.getId(), fx.device.getId(), "BOARDING",
                null, null, photoKey, Instant.now(), Instant.now());
        producer.publish(message);

        awaitUntil(() -> boardingEventRepository.findAllByTenantId(tenantId, Pageable.unpaged())
                .getContent().stream().anyMatch(e -> passenger.getId().equals(e.getPassengerId())), TIMEOUT_SECONDS);
    }

    @Test
    void aBoardingEventWithAPhotoKeyThatCannotBeResolvedStillProcessesWithNoPassengerMatch() throws Exception {
        UUID tenantId = UUID.randomUUID();
        TestFixture fx = persistBusAndDevice(tenantId);

        // No file was ever stored at this key — resolvePassenger() must
        // swallow the read failure and degrade to "unmatched", never throw
        // (which would otherwise trigger the consumer's retry/dead-letter
        // path meant for genuine processing failures, not "couldn't
        // identify who this was").
        TransportDeviceEventMessage message = new TransportDeviceEventMessage(
                UUID.randomUUID(), tenantId, fx.bus.getId(), fx.device.getId(), "BOARDING",
                null, null, "events/does-not-exist/nobody.jpg", Instant.now(), Instant.now());
        producer.publish(message);

        awaitUntil(() -> Objects.equals(occupancyOf(fx.bus.getId()), 1), TIMEOUT_SECONDS);
        List<com.motivity.transport.entity.BoardingEvent> events =
                boardingEventRepository.findAllByTenantId(tenantId, Pageable.unpaged()).getContent();
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getPassengerId()).isNull();
    }

    private Integer occupancyOf(UUID busId) {
        return occupancySnapshotRepository.findByBusId(busId).map(s -> s.getOccupancyCount()).orElse(null);
    }

    private record TestFixture(Bus bus, TransportDevice device) {
    }

    private TestFixture persistBusAndDevice(UUID tenantId) {
        Bus bus = busRepository.save(Bus.builder()
                .tenantId(tenantId)
                .busCode("WORKER-TEST-" + UUID.randomUUID().toString().substring(0, 8))
                .build());
        TransportDevice device = deviceRepository.save(TransportDevice.builder()
                .tenantId(tenantId)
                .busId(bus.getId())
                .deviceCode("WORKER-TEST-DEVICE-" + UUID.randomUUID().toString().substring(0, 8))
                .deviceSecret("worker-test-secret-not-used-for-auth-in-this-test")
                .cameraPosition("boarding")
                .build());
        return new TestFixture(bus, device);
    }

    private TransportDeviceEventMessage boardingEvent(UUID tenantId, UUID busId, UUID deviceId, String eventType) {
        return new TransportDeviceEventMessage(
                UUID.randomUUID(), tenantId, busId, deviceId, eventType,
                null, null, null, Instant.now(), Instant.now());
    }

    private void awaitUntil(BooleanSupplier condition, int timeoutSeconds) {
        long deadline = System.currentTimeMillis() + timeoutSeconds * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) return;
            sleepQuietly(200);
        }
        throw new AssertionError("condition not met within " + timeoutSeconds + "s");
    }

    private void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private ConsumerRecord<String, String> consumeDeadLetterUntilFound(String expectedEventUid, int timeoutSeconds) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-verify-dlq-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);

        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(List.of(topicPrefix + "transport-dead-letter"));
            long deadline = System.currentTimeMillis() + timeoutSeconds * 1000L;
            while (System.currentTimeMillis() < deadline) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
                for (ConsumerRecord<String, String> record : records) {
                    if (record.value().contains(expectedEventUid)) {
                        return record;
                    }
                }
            }
        }
        return null;
    }
}
