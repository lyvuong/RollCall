// Who is staff or a volunteer, from the roster (name + role per member). Names match case-insensitively.

/** Map of lower-case name -> 'staff' | 'volunteer'. */
export const rosterMap = (rows) => new Map(rows.map((r) => [String(r.name).toLowerCase(), r.role]));

/** Known members have a fixed event role: a volunteer is always a volunteer, staff always a participant; null when unknown. */
export const fixedRole = (map, name) => ({ volunteer: 'volunteer', staff: 'participant' })[map.get(String(name).toLowerCase())] || null;
