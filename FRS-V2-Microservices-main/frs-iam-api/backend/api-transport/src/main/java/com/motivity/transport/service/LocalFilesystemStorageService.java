package com.motivity.transport.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * v1 photo storage: local disk, outside the git working tree (see the
 * default root below). Root is created at startup if missing. Every key is
 * resolved and normalized against the root before any filesystem operation
 * — a key like "../../etc/passwd" must never escape the configured root.
 */
@Service
public class LocalFilesystemStorageService implements TransportStorageService {

    private final Path root;

    public LocalFilesystemStorageService(
            @Value("${transport.storage.local-root:/home/ubuntu/FRS_DEV/transport-photos}") String localRoot) {
        this.root = Paths.get(localRoot).toAbsolutePath().normalize();
        try {
            Files.createDirectories(root);
        } catch (IOException e) {
            throw new IllegalStateException("Could not create transport photo storage root: " + root, e);
        }
    }

    @Override
    public String store(String key, byte[] bytes, String contentType) {
        Path target = resolveSafe(key);
        try {
            Files.createDirectories(target.getParent());
            Files.write(target, bytes);
        } catch (IOException e) {
            throw new RuntimeException("Failed to write photo: " + key, e);
        }
        return key;
    }

    @Override
    public byte[] retrieve(String key) {
        try {
            return Files.readAllBytes(resolveSafe(key));
        } catch (IOException e) {
            throw new RuntimeException("Failed to read photo: " + key, e);
        }
    }

    @Override
    public void delete(String key) {
        try {
            Files.deleteIfExists(resolveSafe(key));
        } catch (IOException e) {
            throw new RuntimeException("Failed to delete photo: " + key, e);
        }
    }

    @Override
    public boolean exists(String key) {
        return Files.exists(resolveSafe(key));
    }

    private Path resolveSafe(String key) {
        Path resolved = root.resolve(key).normalize();
        if (!resolved.startsWith(root)) {
            throw new IllegalArgumentException("invalid storage key: " + key);
        }
        return resolved;
    }
}
