// AB#3233 — Permanent fix: precise building/place-name search-and-pin picker,
// replacing the old city/area text-matching coordinate guess.
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// react-leaflet's MapContainer/TileLayer need real browser layout APIs that
// jsdom doesn't provide; stub them out and simulate the draggable Marker with
// a plain button whose click invokes the same eventHandlers.dragend callback
// the real Leaflet Marker would call, so we can assert the drag contract
// without depending on Leaflet's internal DOM/canvas machinery.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => null,
  ZoomControl: () => null,
  Marker: ({ position, eventHandlers }: any) => (
    <button
      type="button"
      data-testid="marker"
      onClick={() =>
        eventHandlers?.dragend?.({
          target: { getLatLng: () => ({ lat: position[0] + 0.01, lng: position[1] + 0.01 }) },
        })
      }
    >
      marker
    </button>
  ),
}));

import { LocationPicker } from './LocationPicker';

const nominatimResponse = [
  {
    place_id: 1,
    display_name: 'Scanalitix, Jubilee Hills, Hyderabad, Telangana, India',
    lat: '17.4321',
    lon: '78.4075',
    address: {
      road: 'Road No. 36',
      suburb: 'Jubilee Hills',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      postcode: '500033',
    },
  },
  { place_id: 2, display_name: 'Scanalitix Towers, Road No. 36, Jubilee Hills, Hyderabad', lat: '17.4330', lon: '78.4080' },
];

// A result where Nominatim only tagged the place with `town` (no `city`) — exercises the fallback chain.
const nominatimResponseTownOnly = [
  {
    place_id: 3,
    display_name: 'Riverside Mill, Old Town Road, Cambridge, Cambridgeshire, England',
    lat: '52.2053',
    lon: '0.1218',
    address: {
      road: 'Old Town Road',
      town: 'Cambridge',
      state: 'Cambridgeshire',
      country: 'United Kingdom',
      postcode: 'CB1 1AA',
    },
  },
];

describe('LocationPicker (AB#3233)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(nominatimResponse),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not search on every keystroke — only after the debounce settles', async () => {
    render(<LocationPicker onLocationSelected={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search building, place name, or landmark/i);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'S' } });
    fireEvent.change(input, { target: { value: 'Sc' } });
    fireEvent.change(input, { target: { value: 'Sca' } });
    fireEvent.change(input, { target: { value: 'Scan' } });
    fireEvent.change(input, { target: { value: 'Scanalitix' } });

    // Not enough time has passed yet for the debounce to fire.
    await vi.advanceTimersByTimeAsync(600);
    expect(global.fetch).not.toHaveBeenCalled();

    // Debounce window (600-800ms) elapses after typing stops.
    await vi.advanceTimersByTimeAsync(200);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as any).mock.calls[0][0]).toContain('nominatim.openstreetmap.org/search');
    expect((global.fetch as any).mock.calls[0][0]).toContain('Scanalitix');
  });

  it('does not fire a search while the input is not focused', async () => {
    render(<LocationPicker onLocationSelected={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search building, place name, or landmark/i);

    fireEvent.change(input, { target: { value: 'Scanalitix' } });
    fireEvent.blur(input);

    await vi.advanceTimersByTimeAsync(800);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows up to 5 results and selecting one calls onLocationSelected with the precise lat/lon', async () => {
    const onLocationSelected = vi.fn();
    render(<LocationPicker onLocationSelected={onLocationSelected} />);
    const input = screen.getByPlaceholderText(/search building, place name, or landmark/i);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Scanalitix' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(screen.getByText('Scanalitix, Jubilee Hills, Hyderabad, Telangana, India')).toBeInTheDocument();
    expect(screen.getByText('Scanalitix Towers, Road No. 36, Jubilee Hills, Hyderabad')).toBeInTheDocument();

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByText('Scanalitix, Jubilee Hills, Hyderabad, Telangana, India'));

    expect(onLocationSelected).toHaveBeenCalledWith({
      latitude: 17.4321,
      longitude: 78.4075,
      displayName: 'Scanalitix, Jubilee Hills, Hyderabad, Telangana, India',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
    });

    // The map preview should now render at the selected pin.
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
  });

  it('falls back to town/village/suburb when the address has no city, and omits fields Nominatim did not return', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(nominatimResponseTownOnly),
    }) as unknown as typeof fetch;

    const onLocationSelected = vi.fn();
    render(<LocationPicker onLocationSelected={onLocationSelected} />);
    const input = screen.getByPlaceholderText(/search building, place name, or landmark/i);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Riverside Mill' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(screen.getByText('Riverside Mill, Old Town Road, Cambridge, Cambridgeshire, England')).toBeInTheDocument();

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByText('Riverside Mill, Old Town Road, Cambridge, Cambridgeshire, England'));

    expect(onLocationSelected).toHaveBeenCalledWith({
      latitude: 52.2053,
      longitude: 0.1218,
      displayName: 'Riverside Mill, Old Town Road, Cambridge, Cambridgeshire, England',
      city: 'Cambridge', // resolved from address.town since address.city was absent
      state: 'Cambridgeshire',
      country: 'United Kingdom',
    });
  });

  it('a result with no address object at all resolves city/state/country as undefined', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve([
        { place_id: 9, display_name: 'Unnamed Landmark', lat: '1.234', lon: '5.678' },
      ]),
    }) as unknown as typeof fetch;

    const onLocationSelected = vi.fn();
    render(<LocationPicker onLocationSelected={onLocationSelected} />);
    const input = screen.getByPlaceholderText(/search building, place name, or landmark/i);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Unnamed Landmark' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByText('Unnamed Landmark'));

    expect(onLocationSelected).toHaveBeenCalledWith({
      latitude: 1.234,
      longitude: 5.678,
      displayName: 'Unnamed Landmark',
      city: undefined,
      state: undefined,
      country: undefined,
    });
  });

  it('dragging the marker updates the coordinate via onLocationSelected', async () => {
    const onLocationSelected = vi.fn();
    render(
      <LocationPicker
        initialLatitude={17.4321}
        initialLongitude={78.4075}
        initialDisplayName="Scanalitix, Jubilee Hills"
        onLocationSelected={onLocationSelected}
      />
    );

    // Editing an existing site with real saved coordinates shows the pin immediately.
    expect(screen.getByTestId('map-container')).toBeInTheDocument();

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('marker'));

    expect(onLocationSelected).toHaveBeenCalledWith({
      latitude: 17.4421,
      longitude: 78.4175,
      displayName: 'Scanalitix, Jubilee Hills',
    });
  });

  it('coerces initialLatitude/initialLongitude when the API returns them as strings (Postgres numeric columns), instead of crashing on toFixed', async () => {
    // Reproduces a real crash: numeric(10,8) columns come back from node-postgres
    // as strings, not numbers, so an existing site's saved coordinates can arrive
    // as "17.4321" rather than 17.4321 despite the `number | null` prop type.
    const onLocationSelected = vi.fn();
    render(
      <LocationPicker
        initialLatitude={'17.4321' as unknown as number}
        initialLongitude={'78.4075' as unknown as number}
        initialDisplayName="Scanalitix, Jubilee Hills"
        onLocationSelected={onLocationSelected}
      />
    );

    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByText(/pin set at 17\.43210°, 78\.40750°/i)).toBeInTheDocument();

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('marker'));

    expect(onLocationSelected).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 17.4421, longitude: 78.4175 })
    );
  });

  it('preserves the address fields resolved by a search selection when the pin is later dragged to fine-tune it', async () => {
    const onLocationSelected = vi.fn();
    render(<LocationPicker onLocationSelected={onLocationSelected} />);
    const input = screen.getByPlaceholderText(/search building, place name, or landmark/i);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Scanalitix' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByText('Scanalitix, Jubilee Hills, Hyderabad, Telangana, India'));

    // Fine-tune the pin by dragging — this is not a new search, just a coordinate nudge.
    await user.click(screen.getByTestId('marker'));

    expect(onLocationSelected).toHaveBeenLastCalledWith({
      latitude: 17.4421,
      longitude: 78.4175,
      displayName: 'Scanalitix, Jubilee Hills, Hyderabad, Telangana, India',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
    });
  });
});
