import type { GridMap, MapConnection } from './types';

export const MAX_CONNECTION_WIDTH = 40;

/** x,row is the first opening cell. North/south extend +X; east/west extend +row. */
export function connectionCells(map: Pick<GridMap, 'cellSize'>, connection: MapConnection): { x: number; row: number }[] {
  const span = Math.max(1, Math.ceil(connection.width / map.cellSize - 1e-9));
  const acrossX = connection.direction === 0 || connection.direction === 180;
  return Array.from({ length: span }, (_, index) => ({ x: connection.x + (acrossX ? index : 0), row: connection.row + (acrossX ? 0 : index) }));
}

export function connectionAt(map: GridMap, x: number, row: number): MapConnection | undefined {
  return map.connections.find(connection => connectionCells(map, connection).some(cell => cell.x === x && cell.row === row));
}

export function maximumConnectionWidth(map: GridMap, connection: MapConnection): number {
  const remaining = connection.direction === 0 || connection.direction === 180 ? map.width - connection.x : map.height - connection.row;
  return Math.min(MAX_CONNECTION_WIDTH, remaining * map.cellSize);
}
